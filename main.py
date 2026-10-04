import asyncio, html, io, json, os, re, sqlite3, time, uuid
from datetime import date, timedelta
from dotenv import load_dotenv
from groq import AsyncGroq
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from pypdf import PdfReader

load_dotenv()  # reads GROQ_API_KEY (and optional MODEL, DB_PATH) from the .env file
if not os.getenv("GROQ_API_KEY"):
    raise SystemExit("GROQ_API_KEY is missing. Add it to the .env file (see .env.example).")
client = AsyncGroq(api_key=os.environ["GROQ_API_KEY"])
MODEL = os.getenv("MODEL", "openai/gpt-oss-120b")
BATCH = 10  # questions per API call
app = FastAPI(title="StudyBuddy")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])
LOCKS: dict = {}     # one background generation at a time per quiz
PDF_DIR = os.getenv("PDF_DIR", "pdfs")  # original PDFs, for the side-by-side viewer
os.makedirs(PDF_DIR, exist_ok=True)

def pdf_path(doc_id: str) -> str:
    return os.path.join(PDF_DIR, f"{doc_id}.pdf")

# ---------- database (SQLite file; set DB_PATH to change location) ----------
DB = sqlite3.connect(os.getenv("DB_PATH", "studybuddy.db"), check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.executescript("""
create table if not exists docs(id text primary key, name text, text text, topics text default '[]', status text, created text default current_timestamp);
create table if not exists quizzes(id text primary key, doc_id text, total int, difficulty text, topic text, questions text default '[]', score int default 0, answered int default 0, created text default current_timestamp);
create table if not exists saved(id integer primary key autoincrement, doc_id text, question text, created text default current_timestamp);
create table if not exists cards(id integer primary key autoincrement, doc_id text, front text, back text, topic text, src_key text, ease real default 2.5, interval int default 0, reps int default 0, due text, last_review text, created text default current_timestamp);
create table if not exists reviews(id integer primary key autoincrement, doc_id text, card_id int, rating int, created text default current_timestamp);
create table if not exists answers(id integer primary key autoincrement, quiz_id text, doc_id text, idx int, question text, picked int, correct int, topic text, created text default current_timestamp);
create table if not exists sources(id text primary key, doc_id text, name text, text text, created text default current_timestamp);
create table if not exists chat(id integer primary key autoincrement, doc_id text, role text, text text, created text default current_timestamp);
create table if not exists messages(id integer primary key autoincrement, doc_id text, role text, text text, created text default current_timestamp);
create table if not exists topic_notes(doc_id text, topic text, note text, primary key(doc_id, topic));
""")

# add columns for exam mode, question types and graded answers (safe to repeat)
for _tbl, _col, _ddl in [("quizzes", "types", "text default 'mcq'"), ("quizzes", "mode", "text default 'practice'"),
                         ("quizzes", "minutes", "int default 0"), ("quizzes", "started", "real"),
                         ("quizzes", "finished", "int default 0"), ("answers", "text", "text"), ("answers", "feedback", "text")]:
    try: DB.execute(f"alter table {_tbl} add column {_col} {_ddl}")
    except sqlite3.OperationalError: pass
DB.commit()

MAX_SOURCES = 10  # PDFs per study space

def migrate_sources():
    """Documents from before multi-PDF support become a study space with one source."""
    for d in DB.execute("select id,name,text from docs where id not in (select doc_id from sources)").fetchall():
        DB.execute("insert into sources(id,doc_id,name,text) values(?,?,?,?)", (d["id"], d["id"], d["name"], d["text"]))
    DB.commit()
migrate_sources()

def correct_text(q: dict) -> str:
    """The right answer as text, for any question type."""
    if q.get("type", "mcq") in ("mcq", "tf"): return q["options"][q["answer"]]
    return (q.get("answer_text") or "").split("|")[0].strip()

def run(sql, *a):
    cur = DB.execute(sql, a); DB.commit(); return cur

def save_msg(doc_id, role, text):
    run("insert into messages(doc_id,role,text) values(?,?,?)", doc_id, role, text)

# ---------- helpers ----------
async def llm(system: str, prompt: str, max_tokens=2000) -> str:
    r = await client.chat.completions.create(
        model=MODEL, max_tokens=max_tokens + 1500, temperature=0.4,  # headroom for reasoning tokens
        extra_body={"reasoning_effort": "low"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}])
    return r.choices[0].message.content

async def llm_stream(messages: list, max_tokens=2000):
    """Yield the reply piece by piece as the model writes it."""
    stream = await client.chat.completions.create(
        model=MODEL, max_tokens=max_tokens + 1500, temperature=0.4, stream=True,
        extra_body={"reasoning_effort": "low"}, messages=messages)
    async for ch in stream:
        piece = ch.choices[0].delta.content if ch.choices else None
        if piece: yield piece

def stream_messages(messages: list, on_done):
    """Stream plain text to the browser, then save the full reply via on_done(text)."""
    async def gen():
        parts = []
        try:
            async for piece in llm_stream(messages):
                parts.append(piece); yield piece
        except Exception as e:
            yield f"\n\nSomething went wrong: {type(e).__name__}: {e}"; return
        on_done("".join(parts))
    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

def sys_user(system: str, prompt: str) -> list:
    return [{"role": "system", "content": system}, {"role": "user", "content": prompt}]

def parse_json(t: str):
    """Parse JSON from a model reply, tolerating code fences or surrounding text."""
    t = re.sub(r"^```(?:json)?|```$", "", t.strip(), flags=re.M).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"[\[{].*[\]}]", t, flags=re.S)
        if not m: raise
        return json.loads(m.group(0))

def words(s: str) -> set:
    return set(re.findall(r"[a-z0-9]{3,}", s.lower()))

def build_chunks(text: str, size=1500):
    chunks, cur = [], ""
    for p in re.split(r"\n\s*\n", text):
        if len(cur) + len(p) > size and cur:
            chunks.append(cur); cur = ""
        cur += p + "\n\n"
    return chunks + ([cur] if cur.strip() else [])

def context(doc: dict, query: str, limit=9000) -> str:
    """Retrieve the chunks of the PDF most relevant to the query."""
    if len(doc["text"]) <= limit:
        return doc["text"]
    q = words(query)
    out, n = [], 0
    for c in sorted(doc["chunks"], key=lambda c: -len(q & words(c))):
        if n + len(c) > limit: break
        out.append(c); n += len(c)
    return "\n---\n".join(out)

def get_doc(doc_id: str) -> dict:
    row = DB.execute("select * from docs where id=?", (doc_id,)).fetchone()
    if not row: raise HTTPException(404, "Document not found")
    d = dict(row)
    rows = DB.execute("select name,text from sources where doc_id=? order by rowid", (doc_id,)).fetchall()
    tag = lambda r: f"[Source: {r['name']}]\n" if len(rows) > 1 else ""
    d["chunks"] = [tag(r) + c for r in rows for c in build_chunks(r["text"])] or build_chunks(d["text"])
    return d

def get_quiz(qid: str) -> dict:
    row = DB.execute("select * from quizzes where id=?", (qid,)).fetchone()
    if not row: raise HTTPException(404, "Quiz not found")
    d = dict(row); d["questions"] = json.loads(d["questions"]); return d

def save_quiz_questions(qid: str, questions: list):
    run("update quizzes set questions=? where id=?", json.dumps(questions), qid)

# ---------- upload + knowledge base + topics ----------
async def build_topics(doc_id: str):
    try:
        rows = DB.execute("select name,text from sources where doc_id=? order by rowid", (doc_id,)).fetchall()
        n, per = len(rows), 14000 // max(1, len(rows))  # sample every PDF, not just the first
        sample = "\n\n".join((f"[{r['name']}]\n" if n > 1 else "") + r["text"][:per] for r in rows)
        out = await llm("You extract study topics. Reply with JSON only.",
                        f"List the 8-{min(15 + 4 * (n - 1), 30)} most important topics across all of this material as a JSON array of short strings.\n\n{sample}", 900)
        run("update docs set topics=?, status='ready' where id=?", json.dumps(parse_json(out)), doc_id)
    except Exception:
        run("update docs set status=case when topics!='[]' then 'ready' else 'error' end where id=?", doc_id)

def rebuild_doc(doc_id: str):
    """Combine all sources into the study space's text, then refresh the topic list in the background."""
    rows = DB.execute("select name,text from sources where doc_id=? order by rowid", (doc_id,)).fetchall()
    text = rows[0]["text"] if len(rows) == 1 else "\n\n".join(f"[Source: {r['name']}]\n{r['text']}" for r in rows)
    run("update docs set text=?, name=?, status='building' where id=?", text, rows[0]["name"], doc_id)
    run("delete from topic_notes where doc_id=?", doc_id)  # the PDFs changed, so cached topic descriptions are stale
    asyncio.create_task(build_topics(doc_id))

async def read_pdf(file: UploadFile):
    data = await file.read()
    if len(data) > 25 * 1024 * 1024: raise HTTPException(413, f"{file.filename} is larger than 25 MB")
    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((p.extract_text() or "") for p in reader.pages).strip()
    except Exception:
        raise HTTPException(400, f"{file.filename} could not be read as a PDF")
    if not text: raise HTTPException(400, f"No readable text found in {file.filename}")
    return data, text

def add_sources(doc_id: str, parsed: list, first_id: str = ""):
    for k, (name, data, text) in enumerate(parsed):
        sid = first_id if (k == 0 and first_id) else uuid.uuid4().hex[:10]
        run("insert into sources(id,doc_id,name,text) values(?,?,?,?)", sid, doc_id, name, text)
        with open(os.path.join(PDF_DIR, f"{sid}.pdf"), "wb") as f: f.write(data)

@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...)):
    """Create a study space from one or more PDFs."""
    if len(files) > MAX_SOURCES: raise HTTPException(400, f"At most {MAX_SOURCES} PDFs per study space")
    parsed = []
    for f in files:
        data, text = await read_pdf(f); parsed.append((f.filename, data, text))
    doc_id = uuid.uuid4().hex[:10]
    run("insert into docs(id,name,text,status) values(?,?,?,'building')", doc_id, parsed[0][0], "")
    add_sources(doc_id, parsed, first_id=doc_id)
    rebuild_doc(doc_id)
    return {"doc_id": doc_id, "name": parsed[0][0]}

@app.post("/api/doc/{doc_id}/sources")
async def add_source(doc_id: str, files: list[UploadFile] = File(...)):
    """Add more PDFs to an existing study space (chat history, quizzes and cards are kept)."""
    if not DB.execute("select 1 from docs where id=?", (doc_id,)).fetchone(): raise HTTPException(404, "Document not found")
    have = DB.execute("select count(*) n from sources where doc_id=?", (doc_id,)).fetchone()["n"]
    if have + len(files) > MAX_SOURCES: raise HTTPException(400, f"At most {MAX_SOURCES} PDFs per study space")
    parsed = []
    for f in files:
        data, text = await read_pdf(f); parsed.append((f.filename, data, text))
    add_sources(doc_id, parsed)
    rebuild_doc(doc_id)
    return {"added": [p[0] for p in parsed]}

@app.delete("/api/doc/{doc_id}/sources/{sid}")
async def remove_source(doc_id: str, sid: str):
    if not DB.execute("select 1 from sources where id=? and doc_id=?", (sid, doc_id)).fetchone(): raise HTTPException(404, "PDF not found")
    if DB.execute("select count(*) n from sources where doc_id=?", (doc_id,)).fetchone()["n"] <= 1:
        raise HTTPException(400, "A study space needs at least one PDF. Delete the whole document instead.")
    run("delete from sources where id=?", sid)
    try: os.remove(os.path.join(PDF_DIR, f"{sid}.pdf"))
    except OSError: pass
    rebuild_doc(doc_id)
    return {"ok": True}

def sources_info(doc_id: str) -> list:
    return [{"id": r["id"], "name": r["name"], "has_pdf": os.path.exists(os.path.join(PDF_DIR, f"{r['id']}.pdf"))}
            for r in DB.execute("select id,name from sources where doc_id=? order by rowid", (doc_id,))]

@app.get("/api/docs")
def list_docs():
    docs = [dict(r) for r in DB.execute(
        "select d.id, d.name, d.created, (select count(*) from sources s where s.doc_id=d.id) as n from docs d order by d.created desc")]
    for d in docs:  # total size of the stored PDFs, shown in the sidebar tooltip
        ids = [r["id"] for r in DB.execute("select id from sources where doc_id=?", (d["id"],))]
        d["size"] = sum(os.path.getsize(pdf_path(i)) for i in ids if os.path.exists(pdf_path(i)))
    return docs

@app.get("/api/doc/{doc_id}")
def doc_status(doc_id: str):
    d = get_doc(doc_id)
    msgs = [dict(r) for r in DB.execute("select role,text from messages where doc_id=? order by id", (doc_id,))]
    quizzes = []
    for r in DB.execute("select id,difficulty,topic,total,answered,score,created,mode,finished,minutes,started from quizzes where doc_id=? order by created desc", (doc_id,)):
        qd = dict(r); qd["over"] = quiz_over(qd); quizzes.append(qd)
    return {"name": d["name"], "status": d["status"], "sources": sources_info(doc_id), "missed": len(missed_questions(doc_id)), "due": due_count(doc_id), "topics": json.loads(d["topics"]), "messages": msgs, "quizzes": quizzes}

@app.delete("/api/doc/{doc_id}")
def delete_doc(doc_id: str):
    for r in DB.execute("select id from sources where doc_id=?", (doc_id,)).fetchall():
        try: os.remove(os.path.join(PDF_DIR, f"{r['id']}.pdf"))
        except OSError: pass
    for t in ("docs", "quizzes", "saved", "messages", "chat", "cards", "reviews", "answers", "sources", "topic_notes"):
        run(f"delete from {t} where " + ("id" if t == "docs" else "doc_id") + "=?", doc_id)
    return {"ok": True}

# ---------- explanations ----------
class ExplainReq(BaseModel):
    doc_id: str
    topic: str
    style: str = "simple language"
    length: str = "medium"
    custom: str = ""
    save: bool = True

DEFAULT_PROMPT = "Explain the topic clearly using the study material. Use {style}. Length: {length}."

EXPLAIN_SYSTEM = "You are a patient tutor. Ground answers in the provided material; say so if it is not covered. The material may combine several documents marked [Source: name]; mention the document name when it helps."

def explain_args(r: ExplainReq):
    d = get_doc(r.doc_id)
    instr = DEFAULT_PROMPT.format(style=r.style, length=r.length)
    if r.custom.strip(): instr += f"\nExtra instructions from the user: {r.custom}"
    return EXPLAIN_SYSTEM, f"{instr}\n\nTopic: {r.topic}\n\nMaterial:\n{context(d, r.topic)}"

@app.post("/api/explain")
async def explain(r: ExplainReq):
    text = await llm(*explain_args(r))
    if r.save:
        save_msg(r.doc_id, "user", r.topic); save_msg(r.doc_id, "assistant", text)
    return {"text": text}

@app.post("/api/explain/stream")
async def explain_stream(r: ExplainReq):
    def done(text):
        if r.save:
            save_msg(r.doc_id, "user", r.topic); save_msg(r.doc_id, "assistant", text)
    return stream_messages(sys_user(*explain_args(r)), done)

class TransformReq(BaseModel):
    doc_id: str = ""
    text: str
    mode: str  # summarize | sticky | memorize

PROMPTS = {
    "summarize": "Summarize this text concisely, highlighting the key points.",
    "sticky": "Convert this text into short sticky notes (max 20 words each), one key idea per note. Separate notes with a line containing only ---",
    "memorize": "Help me memorize this: re-explain it simply, then give mnemonics, analogies, a recall question set and a spaced-repetition tip.",
}

def transform_args(r: TransformReq):
    if r.mode not in PROMPTS: raise HTTPException(400, "Unknown mode")
    return "You are a study assistant.", f"{PROMPTS[r.mode]}\n\n{r.text}"

@app.post("/api/transform")
async def transform(r: TransformReq):
    out = await llm(*transform_args(r))
    if r.doc_id: save_msg(r.doc_id, "sticky" if r.mode == "sticky" else "assistant", out)
    return {"text": out}

@app.post("/api/transform/stream")
async def transform_stream(r: TransformReq):
    def done(text):
        if r.doc_id: save_msg(r.doc_id, "sticky" if r.mode == "sticky" else "assistant", text)
    return stream_messages(sys_user(*transform_args(r)), done)

# ---------- Learn tab: topic card descriptions + clear conversation ----------
class TopicReq(BaseModel):
    doc_id: str
    topic: str

@app.post("/api/topic/describe")
async def topic_describe(r: TopicReq):
    """One-sentence description of a topic for the topic cards. Generated once, then cached."""
    row = DB.execute("select note from topic_notes where doc_id=? and topic=?", (r.doc_id, r.topic)).fetchone()
    if row: return {"note": row["note"]}
    d = get_doc(r.doc_id)
    note = (await llm("You write one-sentence study summaries. Reply with the sentence only.",
                      f"In one sentence of at most 22 words, say what the material covers about this topic.\n\n"
                      f"Topic: {r.topic}\n\nMaterial:\n{context(d, r.topic, 6000)}", 150) or "").strip()
    if note: run("insert or replace into topic_notes(doc_id,topic,note) values(?,?,?)", r.doc_id, r.topic, note)
    return {"note": note}

@app.delete("/api/messages/{doc_id}")
def messages_clear(doc_id: str):
    """Clear chat button in the Learn tab (the Chat tab uses DELETE /api/chat/{doc_id})."""
    run("delete from messages where doc_id=?", doc_id)
    return {"ok": True}

# ---------- quiz: progressive generation + lightweight safeguards ----------
class Q(BaseModel):
    type: str = "mcq"                      # mcq | tf | fill | short
    question: str = Field(min_length=15)
    options: list[str] = Field(default_factory=list)
    answer: int = Field(default=0, ge=0, le=3)
    answer_text: str = ""
    topic: str
    explanation: str

class QuizReq(BaseModel):
    doc_id: str
    n: int = Field(ge=1, le=50)
    difficulty: str = "medium"
    topic: str = ""
    types: list[str] = ["mcq"]
    mode: str = "practice"                 # practice | exam
    minutes: int = Field(default=0, ge=0, le=180)

LEVELS = {"easy": "basic questions testing fundamental concepts",
          "medium": "questions on deeper understanding and applying concepts",
          "hard": "challenging questions needing critical thinking and problem solving"}

TYPE_SPECS = {
    "mcq": '{"type":"mcq","question":...,"options":[4 distinct strings],"answer":index 0-3,"topic":...,"explanation":...}',
    "tf": '{"type":"tf","question":a clear statement,"options":["True","False"],"answer":0 if the statement is true else 1,"topic":...,"explanation":...}',
    "fill": '{"type":"fill","question":a sentence containing ____ in place of the missing term,"answer_text":the missing word or phrase (alternatives separated by |),"topic":...,"explanation":...}',
    "short": '{"type":"short","question":an open question answerable in 1-3 sentences,"answer_text":a model answer,"topic":...,"explanation":...}',
}

def is_duplicate(q: Q, seen: list[set]) -> bool:
    w = words(q.question)
    return any(w and len(w & s) / len(w | s) > 0.6 for s in seen)

def valid(q: Q, seen: list[set]) -> bool:
    if q.type not in TYPE_SPECS or is_duplicate(q, seen): return False
    if q.type == "mcq":
        opts = [o.strip().lower() for o in q.options]
        return len(opts) == 4 and len(set(opts)) == 4 and all(opts)
    if q.type == "tf":
        q.options = ["True", "False"]; return q.answer in (0, 1)
    q.options = []
    if q.type == "fill": return "___" in q.question and bool(q.answer_text.strip())
    return len(q.answer_text.strip()) >= 3

async def generate_batch(quiz: dict, count: int) -> list[dict]:
    doc = get_doc(quiz["doc_id"])
    types = [t for t in (quiz.get("types") or "mcq").split(",") if t in TYPE_SPECS] or ["mcq"]
    specs = "\n".join(f"- {TYPE_SPECS[t]}" for t in types)
    good: list[dict] = []
    for _ in range(3):  # retry on malformed/incomplete output or API failure
        need = count - len(good)
        if need <= 0: break
        avoid = "\n".join("- " + q["question"] for q in quiz["questions"][-40:] + good)
        prompt = (f"Write {need} questions ({LEVELS[quiz['difficulty']]}) "
                  f"{'on the topic: ' + quiz['topic'] if quiz['topic'] else 'across the material'}, using ONLY the material below. "
                  f"Mix these question types evenly and follow each format exactly:\n{specs}\n"
                  "Every question must be unambiguous with exactly one correct answer. Reply with a JSON array of such objects.\n"
                  f"Do not repeat these questions:\n{avoid or '(none)'}\n\nMaterial:\n{context(doc, quiz['topic'] or 'key concepts')}")
        try:
            items = parse_json(await llm("You write exam questions. Reply with JSON only.", prompt, 4500))
        except Exception:
            continue
        seen = [words(q["question"]) for q in quiz["questions"] + good]
        for it in items:
            try:
                q = Q(**it)
            except (ValidationError, TypeError):
                continue
            if valid(q, seen):
                good.append(q.model_dump()); seen.append(words(q.question))
    return good[:count]

def seconds_left(quiz: dict):
    if quiz.get("mode") != "exam": return None
    return max(0, int(quiz["minutes"] * 60 - (time.time() - (quiz["started"] or time.time()))))

def quiz_over(quiz: dict) -> bool:
    return quiz.get("mode") == "exam" and (bool(quiz.get("finished")) or seconds_left(quiz) == 0)

@app.post("/api/quiz/start")
async def quiz_start(r: QuizReq):
    get_doc(r.doc_id)
    exam = r.mode == "exam"
    qid = uuid.uuid4().hex[:10]
    types = ",".join(t for t in r.types if t in TYPE_SPECS) or "mcq"
    quiz = {"doc_id": r.doc_id, "total": r.n, "difficulty": r.difficulty if r.difficulty in LEVELS else "medium",
            "topic": r.topic, "questions": [], "types": types}
    quiz["questions"] = await generate_batch(quiz, min(r.n, BATCH))
    while exam and 0 < len(quiz["questions"]) < r.n:  # exams need every question up front
        more = await generate_batch(quiz, min(r.n - len(quiz["questions"]), BATCH))
        if not more: break
        quiz["questions"] += more
    if not quiz["questions"]: raise HTTPException(502, "Could not generate questions. Try again.")
    total = len(quiz["questions"]) if exam else r.n
    minutes = (r.minutes or max(5, round(total * 1.5))) if exam else 0
    run("insert into quizzes(id,doc_id,total,difficulty,topic,questions,types,mode,minutes,started) values(?,?,?,?,?,?,?,?,?,?)",
        qid, r.doc_id, total, quiz["difficulty"], r.topic, json.dumps(quiz["questions"]), types,
        "exam" if exam else "practice", minutes, time.time() if exam else None)
    return {"quiz_id": qid, "total": total, "questions": quiz["questions"], "mode": "exam" if exam else "practice",
            "seconds_left": minutes * 60 if exam else None}

@app.get("/api/quiz/{qid}")
def quiz_get(qid: str):
    q = get_quiz(qid)
    out = {k: q[k] for k in ("questions", "total", "answered", "score", "mode")}
    out.update(seconds_left=seconds_left(q), over=quiz_over(q))
    return out

@app.post("/api/quiz/{qid}/more")
async def quiz_more(qid: str):
    async with LOCKS.setdefault(qid, asyncio.Lock()):
        quiz = get_quiz(qid)
        remaining = quiz["total"] - len(quiz["questions"])
        if remaining <= 0: return {"questions": []}
        new = await generate_batch(quiz, min(remaining, BATCH))
        quiz["questions"] += new
        save_quiz_questions(qid, quiz["questions"])
        if not new:  # fallback: end gracefully with what we have
            quiz["total"] = len(quiz["questions"]); run("update quizzes set total=? where id=?", quiz["total"], qid)
        return {"questions": new, "total": quiz["total"]}

class Progress(BaseModel):
    answered: int
    score: int

@app.post("/api/quiz/{qid}/progress")
def quiz_progress(qid: str, p: Progress):
    run("update quizzes set answered=?, score=? where id=?", p.answered, p.score, qid)
    return {"ok": True}

# ---------- saved questions ----------
class SaveReq(BaseModel):
    doc_id: str
    question: Q

@app.post("/api/saved")
def saved_add(r: SaveReq):
    run("insert into saved(doc_id,question) values(?,?)", r.doc_id, r.question.model_dump_json())
    return {"ok": True}

@app.get("/api/saved")
def saved_list(doc_id: str):
    return [{"id": r["id"], **json.loads(r["question"])} for r in
            DB.execute("select id,question from saved where doc_id=? order by id desc", (doc_id,))]

@app.delete("/api/saved/{sid}")
def saved_delete(sid: int):
    run("delete from saved where id=?", sid); return {"ok": True}

# ---------- chat with the document (remembers the conversation) ----------
CHAT_SYSTEM = ("You are a study assistant chatting about the user's document. Answer from the document excerpts. "
               "If the document does not cover something, say so, then add general knowledge clearly labelled as such. Be concise. The material may combine several documents, each marked [Source: name]; mention the document name when it helps.")

class ChatReq(BaseModel):
    doc_id: str
    message: str = Field(min_length=1)

@app.post("/api/chat/stream")
async def chat_stream(r: ChatReq):
    d = get_doc(r.doc_id)
    hist = [dict(x) for x in DB.execute("select role,text from chat where doc_id=? order by id desc limit 12", (r.doc_id,))][::-1]
    prev = [h["text"] for h in hist if h["role"] == "user"][-1:]
    ctx = context(d, " ".join([r.message] + prev))
    msgs = ([{"role": "system", "content": CHAT_SYSTEM}] + [{"role": h["role"], "content": h["text"]} for h in hist] +
            [{"role": "user", "content": f"Document excerpts:\n{ctx}\n\nQuestion: {r.message}"}])
    run("insert into chat(doc_id,role,text) values(?,?,?)", r.doc_id, "user", r.message)
    return stream_messages(msgs, lambda t: run("insert into chat(doc_id,role,text) values(?,?,?)", r.doc_id, "assistant", t))

@app.get("/api/chat/{doc_id}")
def chat_history(doc_id: str):
    return [dict(x) for x in DB.execute("select role,text from chat where doc_id=? order by id", (doc_id,))]

@app.delete("/api/chat/{doc_id}")
def chat_clear(doc_id: str):
    run("delete from chat where doc_id=?", doc_id); return {"ok": True}

# ---------- original PDF (side-by-side viewer) ----------
@app.get("/api/doc/{doc_id}/pdf")
def doc_pdf(doc_id: str, source: str = ""):
    row = DB.execute("select id from sources where doc_id=? and (id=? or ?='') order by rowid limit 1", (doc_id, source, source)).fetchone()
    if not row: raise HTTPException(404, "Document not found")
    path = os.path.join(PDF_DIR, f"{row['id']}.pdf")
    if not os.path.exists(path): raise HTTPException(404, "Original PDF was not stored")
    return FileResponse(path, media_type="application/pdf", headers={"Content-Disposition": "inline"})

# ---------- export ----------
def saved_questions(doc_id: str) -> list:
    return [json.loads(r["question"]) for r in DB.execute("select question from saved where doc_id=? order by id", (doc_id,))]

def notes_markdown(doc_id: str) -> str:
    d = get_doc(doc_id)
    srcs = [r["name"] for r in DB.execute("select name from sources where doc_id=? order by rowid", (doc_id,))]
    extra = f" + {len(srcs) - 1} more" if len(srcs) > 1 else ""
    out = [f"# {d['name']}{extra}: study notes\n"]
    if len(srcs) > 1: out.append("## Sources\n\n" + "\n".join(f"- {n}" for n in srcs) + "\n")
    topics = json.loads(d["topics"])
    if topics: out.append("## Key topics\n\n" + "\n".join(f"- {t}" for t in topics) + "\n")
    msgs = DB.execute("select role,text from messages where doc_id=? order by id", (doc_id,)).fetchall()
    if msgs: out.append("## Explanations and notes\n")
    for m in msgs:
        if m["role"] == "user": out.append(f"### {m['text']}\n")
        elif m["role"] == "sticky":
            out.append("**Sticky notes**\n\n" + "\n".join("- " + x.strip() for x in re.split(r"\n-{3,}\n?", m["text"]) if x.strip()) + "\n")
        else: out.append(m["text"] + "\n")
    qs = saved_questions(doc_id)
    if qs:
        out.append("## Saved questions\n")
        for n, q in enumerate(qs, 1):
            opts = f"   - Answer: {correct_text(q)}" if q.get("type", "mcq") not in ("mcq", "tf") else "\n".join(f"   - {'ABCD'[i]}. {o}" + ("  **(correct)**" if i == q["answer"] else "") for i, o in enumerate(q["options"]))
            out.append(f"{n}. **{q['question']}**\n{opts}\n   - Why: {q['explanation']}\n")
    return "\n".join(out)

def file_base(doc_id: str) -> str:
    name = DB.execute("select name from docs where id=?", (doc_id,)).fetchone()
    return re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(name["name"] if name else "notes")[0]) or "notes"

@app.get("/api/export/{doc_id}/notes.md")
def export_notes(doc_id: str):
    return PlainTextResponse(notes_markdown(doc_id), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{file_base(doc_id)}-notes.md"'})

@app.get("/api/export/{doc_id}/anki.txt")
def export_anki(doc_id: str):
    """Tab-separated file. In Anki: File > Import, then pick this file."""
    h = lambda t: html.escape(t).replace("\t", " ").replace("\n", "<br>")
    rows = ["#separator:tab", "#html:true", "#tags column:3"]
    bold = lambda t: re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", h(t))
    cards = DB.execute("select front,back,topic from cards where doc_id=? order by id", (doc_id,)).fetchall()
    if cards:  # all flashcards (saved questions + sticky notes)
        for c in cards:
            rows.append(f"{h(c['front'])}\t{bold(c['back'])}\t{re.sub(r'[^A-Za-z0-9_]+', '_', c['topic'] or 'notes')}")
        return PlainTextResponse("\n".join(rows) + "\n", media_type="text/plain; charset=utf-8",
                                 headers={"Content-Disposition": f'attachment; filename="{file_base(doc_id)}-anki.txt"'})
    for q in saved_questions(doc_id):
        front = h(q["question"]) + (("<br><br>" + "<br>".join(f"{'ABCD'[i]}. {h(o)}" for i, o in enumerate(q["options"]))) if q.get("type", "mcq") in ("mcq", "tf") else "")
        back = f"<b>{h(correct_text(q))}</b><br><br>{h(q['explanation'])}"
        rows.append(f"{front}\t{back}\t{re.sub(r'[^A-Za-z0-9_]+', '_', q['topic'])}")
    return PlainTextResponse("\n".join(rows) + "\n", media_type="text/plain; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{file_base(doc_id)}-anki.txt"'})

# ---------- wrong-answer review ----------
class DocReq(BaseModel):
    doc_id: str

class AnswerReq(BaseModel):
    index: int
    picked: int | None = None
    text: str = ""

def norm(t: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", t.lower()).split())

GRADE_FORMAT = 'Reply with JSON like {"correct": true, "feedback": "one short sentence"}. Accept answers that capture the key idea even if worded differently.'

async def grade(q: dict, a: AnswerReq):
    t = q.get("type", "mcq")
    if t in ("mcq", "tf"): return a.picked == q["answer"], ""
    if t == "fill": return norm(a.text) in {norm(x) for x in q.get("answer_text", "").split("|")}, ""
    if not a.text.strip(): return False, "No answer given."
    try:  # short answer: the model grades it
        out = parse_json(await llm("You grade student answers fairly. Reply with JSON only.",
                                   f"Question: {q['question']}\nModel answer: {q['answer_text']}\nStudent answer: {a.text}\n{GRADE_FORMAT}", 400))
        return bool(out.get("correct")), str(out.get("feedback", ""))
    except Exception:
        return norm(a.text) == norm(q["answer_text"]), "Could not be graded automatically."

@app.post("/api/quiz/{qid}/answer")
async def quiz_answer(qid: str, a: AnswerReq):
    quiz = get_quiz(qid)
    if quiz_over(quiz): raise HTTPException(400, "The exam is over")
    if not 0 <= a.index < len(quiz["questions"]): raise HTTPException(400, "No such question")
    q = quiz["questions"][a.index]
    old = DB.execute("select correct,feedback from answers where quiz_id=? and idx=?", (qid, a.index)).fetchone()
    if old: ok, fb = bool(old["correct"]), old["feedback"] or ""
    else:
        ok, fb = await grade(q, a)
        run("insert into answers(quiz_id,doc_id,idx,question,picked,correct,topic,text,feedback) values(?,?,?,?,?,?,?,?,?)",
            qid, quiz["doc_id"], a.index, json.dumps(q), a.picked, int(ok), q.get("topic", ""), a.text, fb)
    row = DB.execute("select count(*) n, coalesce(sum(correct),0) s from answers where quiz_id=?", (qid,)).fetchone()
    run("update quizzes set answered=?, score=? where id=?", row["n"], row["s"], qid)
    if quiz["mode"] == "exam": return {"ok": True}  # no hints during an exam
    return {"answered": row["n"], "score": row["s"], "correct": ok, "feedback": fb}

@app.post("/api/quiz/{qid}/finish")
def quiz_finish(qid: str):
    quiz = get_quiz(qid)
    for i, q in enumerate(quiz["questions"]):  # unanswered questions count as wrong
        if not DB.execute("select 1 from answers where quiz_id=? and idx=?", (qid, i)).fetchone():
            run("insert into answers(quiz_id,doc_id,idx,question,picked,correct,topic,text,feedback) values(?,?,?,?,NULL,0,?,'','')",
                qid, quiz["doc_id"], i, json.dumps(q), q.get("topic", ""))
    run("update quizzes set finished=1 where id=?", qid)
    row = DB.execute("select count(*) n, coalesce(sum(correct),0) s from answers where quiz_id=?", (qid,)).fetchone()
    run("update quizzes set answered=?, score=? where id=?", row["n"], row["s"], qid)
    return {"ok": True}

@app.get("/api/quiz/{qid}/results")
def quiz_results(qid: str):
    quiz = get_quiz(qid)
    if quiz["mode"] == "exam" and not quiz_over(quiz): raise HTTPException(403, "Finish the exam to see the results")
    if quiz["mode"] == "exam" and not quiz["finished"]: quiz_finish(qid)  # time ran out
    ans = {r["idx"]: r for r in DB.execute("select * from answers where quiz_id=?", (qid,))}
    items, topics = [], {}
    for i, q in enumerate(quiz["questions"]):
        a = ans.get(i); ok = bool(a and a["correct"])
        items.append({"question": q, "picked": a["picked"] if a else None, "text": (a["text"] or "") if a else "",
                      "correct": ok, "answered": bool(a and (a["picked"] is not None or (a["text"] or "").strip())),
                      "feedback": (a["feedback"] or "") if a else ""})
        n, c = topics.get(q.get("topic") or "General", (0, 0)); topics[q.get("topic") or "General"] = (n + 1, c + ok)
    return {"mode": quiz["mode"], "minutes": quiz["minutes"], "total": len(items), "score": sum(x["correct"] for x in items),
            "items": items, "topics": [{"topic": t, "total": n, "correct": c} for t, (n, c) in sorted(topics.items(), key=lambda kv: kv[1][1] / kv[1][0])]}

def missed_questions(doc_id: str) -> list:
    """Questions whose most recent answer was wrong (a later correct answer clears them)."""
    last = {}
    for r in DB.execute("select question,correct from answers where doc_id=? order by id", (doc_id,)):
        q = json.loads(r["question"]); last[q["question"].strip().lower()] = (q, r["correct"])
    return [q for q, ok in last.values() if not ok]

@app.post("/api/quiz/retry")
def quiz_retry(r: DocReq):
    qs = missed_questions(r.doc_id)
    if not qs: raise HTTPException(400, "No missed questions to review")
    qid = uuid.uuid4().hex[:10]
    run("insert into quizzes(id,doc_id,total,difficulty,topic,questions) values(?,?,?,?,?,?)",
        qid, r.doc_id, len(qs), "review", "Missed questions", json.dumps(qs))
    return {"quiz_id": qid, "total": len(qs), "questions": qs}

# ---------- flashcards with spaced repetition ----------
def today() -> str:
    return date.today().isoformat()

def due_count(doc_id: str) -> int:
    return DB.execute("select count(*) n from cards where doc_id=? and due<=?", (doc_id, today())).fetchone()["n"]

def add_card(doc_id, front, back, topic, key):
    run("insert into cards(doc_id,front,back,topic,src_key,due) values(?,?,?,?,?,?)", doc_id, front, back, topic, key, today())

CARD_PROMPT = ('Turn each note into one flashcard. Reply with a JSON array of objects {"front": a question, '
               '"back": a short answer}.\n\nNotes:\n')

@app.post("/api/cards/generate")
async def cards_generate(r: DocReq):
    """Idempotent: builds cards from saved questions and sticky notes that have none yet."""
    existing = {x["src_key"] for x in DB.execute("select distinct src_key from cards where doc_id=?", (r.doc_id,))}
    added = 0
    for row in DB.execute("select id,question from saved where doc_id=? order by id", (r.doc_id,)).fetchall():
        key = f"saved:{row['id']}"
        if key in existing: continue
        q = json.loads(row["question"])
        add_card(r.doc_id, q["question"], f"**{correct_text(q)}**\n\n{q['explanation']}", q["topic"], key); added += 1
    stickies = [m for m in DB.execute("select id,text from messages where doc_id=? and role='sticky' order by id", (r.doc_id,))
                if f"msg:{m['id']}" not in existing][:10]
    for m in stickies:
        notes = [x.strip() for x in re.split(r"\n-{3,}\n?", m["text"]) if x.strip()]
        try:
            items = parse_json(await llm("You write flashcards. Reply with JSON only.", CARD_PROMPT + "\n".join(f"- {n}" for n in notes), 2500))
        except Exception:
            continue
        for it in items:
            if isinstance(it, dict) and it.get("front") and it.get("back"):
                add_card(r.doc_id, str(it["front"]), str(it["back"]), "Sticky notes", f"msg:{m['id']}"); added += 1
    return {"added": added}

@app.get("/api/cards/{doc_id}/stats")
def cards_stats(doc_id: str):
    r = DB.execute("select count(*) total, sum(due<=?) due, sum(last_review is null) new from cards where doc_id=?", (today(), doc_id)).fetchone()
    nxt = DB.execute("select min(due) d from cards where doc_id=? and due>?", (doc_id, today())).fetchone()["d"]
    return {"total": r["total"] or 0, "due": r["due"] or 0, "new": r["new"] or 0, "next_due": nxt}

@app.get("/api/cards/{doc_id}/due")
def cards_due(doc_id: str, limit: int = 30):
    return [dict(x) for x in DB.execute(
        "select id,front,back,topic from cards where doc_id=? and due<=? order by due,id limit ?", (doc_id, today(), limit))]

class ReviewReq(BaseModel):
    rating: int = Field(ge=0, le=3)  # 0 again, 1 hard, 2 good, 3 easy

@app.post("/api/cards/{card_id}/review")
def card_review(card_id: int, r: ReviewReq):
    c = DB.execute("select * from cards where id=?", (card_id,)).fetchone()
    if not c: raise HTTPException(404, "Card not found")
    ease, interval, reps = c["ease"], c["interval"], c["reps"]
    if r.rating == 0:  # forgot: start over, see it again today
        ease, interval, reps = max(1.3, ease - 0.2), 0, 0
    else:
        if reps == 0: interval = {1: 1, 2: 1, 3: 4}[r.rating]
        elif reps == 1: interval = {1: 3, 2: 6, 3: 8}[r.rating]
        else: interval = max(interval + 1, round(interval * (1.2 if r.rating == 1 else ease * (1.3 if r.rating == 3 else 1))))
        ease = max(1.3, ease + {1: -0.15, 2: 0, 3: 0.15}[r.rating]); reps += 1
    due = (date.today() + timedelta(days=interval)).isoformat()
    run("update cards set ease=?,interval=?,reps=?,due=?,last_review=? where id=?", ease, interval, reps, due, today(), card_id)
    run("insert into reviews(doc_id,card_id,rating) values(?,?,?)", c["doc_id"], card_id, r.rating)
    return {"interval": interval, "due": due}

# ---------- study dashboard ----------
@app.get("/api/dashboard/{doc_id}")
def dashboard(doc_id: str):
    counts = {}
    for table in ("answers", "reviews"):
        for r in DB.execute(f"select date(created,'localtime') d, count(*) n from {table} where doc_id=? group by d", (doc_id,)):
            counts[r["d"]] = counts.get(r["d"], 0) + r["n"]
    t0 = date.today()
    d, streak = (t0 if t0.isoformat() in counts else t0 - timedelta(days=1)), 0
    while d.isoformat() in counts: streak += 1; d -= timedelta(days=1)
    best = run_len = 0; prev = None
    for ds in sorted(counts):
        dt = date.fromisoformat(ds); run_len = run_len + 1 if prev and (dt - prev).days == 1 else 1
        best = max(best, run_len); prev = dt
    trend = [{"date": r["d"], "pct": round(100 * r["s"] / r["n"]), "n": r["n"]} for r in DB.execute(
        "select min(date(created,'localtime')) d, count(*) n, sum(correct) s from answers where doc_id=? group by quiz_id order by min(created) desc limit 20", (doc_id,))][::-1]
    topics = [{"topic": r["topic"] or "General", "n": r["n"], "pct": round(100 * r["s"] / r["n"])} for r in DB.execute(
        "select topic, count(*) n, sum(correct) s from answers where doc_id=? group by topic", (doc_id,))]
    tot = DB.execute("select count(*) n, coalesce(sum(correct),0) s from answers where doc_id=?", (doc_id,)).fetchone()
    cards = DB.execute("select count(*) total, coalesce(sum(interval>=21),0) mastered from cards where doc_id=?", (doc_id,)).fetchone()
    reviewed = DB.execute("select count(*) n from reviews where doc_id=?", (doc_id,)).fetchone()["n"]
    return {"streak": streak, "best_streak": best, "answered": tot["n"], "accuracy": round(100 * tot["s"] / tot["n"]) if tot["n"] else None,
            "trend": trend, "topics": topics, "cards": {"total": cards["total"], "mastered": cards["mastered"], "due": due_count(doc_id), "reviews": reviewed},
            "activity": [{"date": (t0 - timedelta(days=k)).isoformat(), "n": counts.get((t0 - timedelta(days=k)).isoformat(), 0)} for k in range(13, -1, -1)]}

# Serve the built React app (frontend/dist). In development use `npm run dev` instead.
DIST = os.path.join(os.path.dirname(__file__), "frontend", "dist")
if os.path.isdir(DIST):
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
else:
    @app.get("/")
    def root():
        return {"message": "Frontend not built. Run `npm run build` in frontend/, or `npm run dev` and open http://localhost:5173"}