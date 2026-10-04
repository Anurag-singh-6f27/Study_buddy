import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { renderToStaticMarkup } from "react-dom/server";
import { api, stream } from "./api";

const pretty = (n) => n.replace(/\.pdf$/i, "").replace(/_+/g, " ").trim() || n;
function PageHead({ title, sub }) {
  return <div className="ph"><h3>{title}</h3>{sub && <p className="muted">{sub}</p>}</div>;
}

/* ---------- icons ---------- */
const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const ICONS = {
  sources: <><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" /></>,
  pdf: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  left: <path d="M15 18l-6-6 6-6" />,
  right: <path d="M9 18l6-6-6-6" />,
  dots: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  open: <><path d="M14 3h7v7" /><path d="M10 14L21 3" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" /></>,
};
const Icon = ({ n, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[n]}</svg>
);

/* ---------- small helpers ---------- */
const HUES = ["#ef4444", "#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ec4899"];
const hueOf = (id) => HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const fmtDate = (s, short) => {
  const d = new Date(String(s).replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, short && thisYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
};
const docMeta = (d) => [d.n > 1 && `${d.n} PDFs`, d.size && fmtSize(d.size), fmtDate(d.created, true)].filter(Boolean).join(" · ");

// Width of the thread's scrollbar, so the composer and Clear chat line up with the messages
function useGutter() {
  const ref = useRef();
  const [sb, setSb] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setSb(el.offsetWidth - el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, { "--sb": sb + "px" }];
}

async function exportPdf(doc) {
  const md = await (await fetch(`/api/export/${doc.id}/notes.md`)).text();
  const body = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown>);
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${doc.name.replace(/</g, "")} notes</title><style>
    body{font:14px/1.6 Georgia,serif;max-width:720px;margin:2rem auto;color:#111}h1,h2,h3{font-family:system-ui,sans-serif}
    table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}</style></head><body>${body}</body></html>`;
  f.onload = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 3000); };
  document.body.appendChild(f);
}

// Markdown with GitHub-style tables, scrollable on small screens
const mdParts = { table: (p) => <div className="tbl"><table {...p} /></div> };
function MD({ children }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={mdParts}>{children}</Markdown>;
}

/* ---------- shared chat composer (Learn + Chat) ---------- */
function Composer({ value, onChange, onSend, busy, placeholder, sendLabel, rows = 1, extras, popup }) {
  const ta = useRef();
  useEffect(() => {
    const t = ta.current; if (!t) return;
    t.style.height = "auto";
    const h = t.scrollHeight;  // 0 while the tab is hidden: keep "auto" so the field isn't collapsed
    if (h > 0) { t.style.height = Math.min(h, 200) + "px"; t.style.overflowY = h > 200 ? "auto" : "hidden"; }
  }, [value]);
  return (
    <div className="composer"><div className="col">
      {popup}
      <div className="cbox">
        <div className="cin">
          <textarea ref={ta} rows={rows} value={value} placeholder={placeholder} aria-label={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); } }} />
          <button className="send" aria-label={sendLabel} title={`${sendLabel} (Enter)`} disabled={busy || !value.trim()} onClick={onSend}><Icon n="up" size={20} /></button>
        </div>
        {extras && <div className="cfoot">{extras}</div>}
      </div>
    </div></div>
  );
}

/* ---------- app shell ---------- */
export default function App() {
  const [docs, setDocs] = useState([]);
  const [docId, setDocId] = useState(null);
  const [tab, setTab] = useState("learn");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("side") === "1");
  const fileRef = useRef();
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("theme", theme); }, [theme]);
  useEffect(() => { localStorage.setItem("side", collapsed ? "1" : "0"); }, [collapsed]);

  const refresh = () => api("/api/docs").then(setDocs).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); }, []);

  async function upload(e) {
    const files = [...e.target.files];
    if (!files.length) return;
    setBusy(true); setErr("");
    const form = new FormData(); files.forEach((f) => form.append("files", f));
    try {
      const d = await api("/api/upload", { form });
      await refresh(); setDocId(d.doc_id); setTab("learn");
    } catch (x) { setErr(x.message); }
    setBusy(false); e.target.value = "";
  }
  async function remove(d) {
    if (!confirm(`Delete "${pretty(d.name)}" and everything saved for it?`)) return;
    await api(`/api/doc/${d.id}`, { method: "DELETE" });
    if (docId === d.id) setDocId(null);
    refresh();
  }
  const select = (id) => { setDocId(id); setTab("learn"); };

  return (
    <div className={"shell" + (collapsed ? " collapsed" : "")}>
      <Sidebar docs={docs} docId={docId} select={select} remove={remove} onUpload={() => fileRef.current.click()} busy={busy} err={err}
        theme={theme} setTheme={setTheme} collapsed={collapsed} setCollapsed={setCollapsed} />
      <input ref={fileRef} type="file" accept="application/pdf" multiple hidden onChange={upload} />
      <main className="main">
        {docId ? <Workspace key={docId} id={docId} tab={tab} setTab={setTab} /> : (
          <div className="center">
            <h1>Turn your PDFs into a study session</h1>
            <p className="muted">Upload a document to get explanations, notes and quizzes built from its content.</p>
            <button className="btn primary" onClick={() => fileRef.current.click()}>Upload PDFs</button>
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------- sidebar: tooltips, file icons, menu, collapsible ---------- */
function Sidebar({ docs, docId, select, remove, onUpload, busy, err, theme, setTheme, collapsed, setCollapsed }) {
  const [q, setQ] = useState("");
  const [tip, setTip] = useState(null);
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e) => e.key === "Escape" && close();
    window.addEventListener("click", close); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", key); };
  }, [menu]);

  const shown = q.trim() ? docs.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase())) : docs;
  const showTip = (d, e) => {
    const r = e.currentTarget.closest(".doc").getBoundingClientRect();
    setTip({ d, top: r.top, left: r.right + 10 });
  };
  const openMenu = (d, e) => {
    e.stopPropagation(); setTip(null);
    if (menu?.d.id === d.id) return setMenu(null);
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ d, top: r.bottom + 4, left: Math.max(8, r.right - 168) });
  };

  return (
    <aside className="side" aria-label="Documents">
      <div className="brand">
        <div className="logo"><i /><span className="lt">StudyBuddy</span></div>
        <button className="iconbtn collapse" aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed(!collapsed)}>
          <Icon n={collapsed ? "right" : "left"} />
        </button>
      </div>
      <button className="btn note block" disabled={busy} onClick={onUpload} aria-label="Upload PDFs" title="Upload PDFs">
        <Icon n="plus" /><span className="lbl">{busy ? "Reading PDFs…" : "Upload PDFs"}</span>
      </button>
      {err && <p className="side-err">{err}</p>}
      <p className="side-label">Documents</p>
      {docs.length >= 5 && (
        <div className="dsearch">
          <Icon n="search" size={15} />
          <input value={q} placeholder="Search documents…" aria-label="Search documents" onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="doclist">
        {shown.map((d) => {
          const on = d.id === docId;
          return (
            <div key={d.id} className={"doc" + (on ? " on" : "")} onMouseEnter={(e) => showTip(d, e)} onMouseLeave={() => setTip(null)}>
              <button className="docbtn" aria-current={on ? "true" : undefined} aria-label={pretty(d.name)}
                onFocus={(e) => showTip(d, e)} onBlur={() => setTip(null)} onClick={() => select(d.id)}>
                <span className="ftile" style={{ "--c": hueOf(d.id) }}><Icon n="pdf" /></span>
                <span className="dtext">
                  <span className="dname"><span className="dt">{pretty(d.name)}</span>{d.n > 1 && <span className="more">+{d.n - 1}</span>}</span>
                  <span className="dmeta">{docMeta(d)}</span>
                </span>
              </button>
              <button className="dmenu" aria-label={`Options for ${pretty(d.name)}`} aria-haspopup="menu" aria-expanded={menu?.d.id === d.id} onClick={(e) => openMenu(d, e)}>
                <Icon n="dots" />
              </button>
            </div>
          );
        })}
        {!docs.length && (
          <div className="empty">
            <Icon n="pdf" size={30} />
            <b className="eh">No documents yet</b>
            <span className="eh">Upload a PDF to start a focused study session.</span>
          </div>
        )}
        {docs.length > 0 && !shown.length && <p className="side-muted">No documents match your search.</p>}
      </div>
      <div className="sidefoot">
        <span className="fcount">{docs.length} document{docs.length === 1 ? "" : "s"}</span>
        <button className="iconbtn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={theme === "dark" ? "Light mode" : "Dark mode"}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </button>
      </div>
      {tip && !menu && (
        <div className="tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          <b>{tip.d.name}</b>
          {tip.d.n > 1 && <span>+ {tip.d.n - 1} more PDF{tip.d.n - 1 === 1 ? "" : "s"}</span>}
          <span>{[tip.d.size && fmtSize(tip.d.size), fmtDate(tip.d.created) && "Added " + fmtDate(tip.d.created)].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      {menu && (
        <div className="menu float" role="menu" style={{ top: menu.top, left: menu.left }} onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { select(menu.d.id); setMenu(null); }}><Icon n="open" />Open</button>
          <button role="menuitem" className="danger" onClick={() => { remove(menu.d); setMenu(null); }}><Icon n="trash" />Remove</button>
        </div>
      )}
    </aside>
  );
}

function Workspace({ id, tab, setTab }) {
  const [doc, setDoc] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [srcMenu, setSrcMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [srcErr, setSrcErr] = useState("");
  const [viewSrc, setViewSrc] = useState(null);
  const [rev, setRev] = useState(0);
  const addRef = useRef();
  const load = async () => { const d = await api(`/api/doc/${id}`); setDoc({ ...d, id }); return d; };
  useEffect(() => {
    let t;
    const poll = async () => { const d = await load(); if (d.status === "building") t = setTimeout(poll, 1500); };
    poll();
    return () => clearTimeout(t);
  }, [id, rev]);
  // close the Sources / Export menus on outside click or Escape
  useEffect(() => {
    if (!menu && !srcMenu) return;
    const close = () => { setMenu(false); setSrcMenu(false); };
    const click = (e) => { if (!e.target.closest(".menu-wrap")) close(); };
    const key = (e) => e.key === "Escape" && close();
    window.addEventListener("click", click); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("click", click); window.removeEventListener("keydown", key); };
  }, [menu, srcMenu]);
  if (!doc) return <div className="center muted">Loading…</div>;
  const download = (file) => { const l = document.createElement("a"); l.href = `/api/export/${id}/${file}`; l.click(); setMenu(false); };
  async function addPdf(e) {
    const files = [...e.target.files];
    if (!files.length) return;
    setAdding(true); setSrcErr("");
    const form = new FormData(); files.forEach((f) => form.append("files", f));
    try { await api(`/api/doc/${id}/sources`, { form }); setRev((r) => r + 1); }
    catch (x) { setSrcErr(x.message); }
    setAdding(false); e.target.value = "";
  }
  async function removeSrc(s) {
    if (!confirm(`Remove ${s.name} from this study space?`)) return;
    setSrcErr("");
    try { await api(`/api/doc/${id}/sources/${s.id}`, { method: "DELETE" }); if (viewSrc === s.id) setViewSrc(null); setRev((r) => r + 1); }
    catch (x) { setSrcErr(x.message); }
  }
  const n = doc.sources.length;
  const viewing = doc.sources.find((s) => s.id === viewSrc) || doc.sources[0];
  return (
    <>
      <header className="head">
        <div className="head-row">
          <div className="titleblock">
            <h2 title={doc.sources.map((s) => s.name).join(", ")}><span className="tname">{pretty(doc.name)}</span>{n > 1 && <span className="more">+{n - 1} more</span>}</h2>
            <span className="muted small">{doc.status === "building" ? "Reading your PDFs and finding key topics…" : `${doc.topics.length} key topics · ${n} PDF${n === 1 ? "" : "s"}`}</span>
          </div>
          <div className="head-actions">
            <div className="menu-wrap">
              <button className="btn ghost tool" aria-expanded={srcMenu} onClick={() => { setSrcMenu(!srcMenu); setMenu(false); }}>
                <Icon n="sources" />Sources<b className="badge">{n}</b>
              </button>
              <input ref={addRef} type="file" accept="application/pdf" multiple hidden onChange={addPdf} />
              {srcMenu && (
                <div className="menu srcmenu">
                  {doc.sources.map((s) => (
                    <div key={s.id} className="src">
                      <span title={s.name}>{pretty(s.name)}</span>
                      {n > 1 && <button className="x" aria-label={`Remove ${s.name}`} onClick={() => removeSrc(s)}>×</button>}
                    </div>
                  ))}
                  <button className="btn note block" disabled={adding} onClick={() => addRef.current.click()}>{adding ? "Adding…" : "Add PDFs"}</button>
                  {srcErr && <p className="err-text small">{srcErr}</p>}
                </div>
              )}
            </div>
            <button className={"btn ghost tool" + (pdfOpen ? " on" : "")} aria-pressed={pdfOpen} onClick={() => setPdfOpen(!pdfOpen)}>
              <Icon n="pdf" />PDF
            </button>
            <div className="menu-wrap">
              <button className="btn ghost tool" aria-expanded={menu} onClick={() => { setMenu(!menu); setSrcMenu(false); }}>
                <Icon n="download" />Export
              </button>
              {menu && (
                <div className="menu">
                  <button onClick={() => download("notes.md")}>Notes (Markdown)</button>
                  <button onClick={() => { exportPdf(doc); setMenu(false); }}>Notes (PDF)</button>
                  <button onClick={() => download("anki.txt")}>Flashcards (Anki)</button>
                </div>
              )}
            </div>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {[["learn", "Learn"], ["chat", "Chat"], ["quiz", "Quiz"], ["cards", "Cards"], ["progress", "Progress"], ["saved", "Saved"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
              {l}{k === "cards" && doc.due > 0 && <b className="badge">{doc.due}</b>}
            </button>
          ))}
        </nav>
      </header>
      <div className="body">
        <div className="content">
          <div hidden={tab !== "learn"} className="pane wide"><Learn doc={doc} /></div>
          <div hidden={tab !== "chat"} className="pane wide"><Chat doc={doc} /></div>
          <div hidden={tab !== "quiz"} className="pane"><Quiz doc={doc} reload={load} /></div>
          <div hidden={tab !== "cards"} className="pane"><Cards doc={doc} active={tab === "cards"} reload={load} /></div>
          <div hidden={tab !== "progress"} className="pane"><Progress doc={doc} active={tab === "progress"} /></div>
          <div hidden={tab !== "saved"} className="pane"><Saved doc={doc} active={tab === "saved"} /></div>
        </div>
        {pdfOpen && (
          <aside className="pdfpane">
            {n > 1 && (
              <div className="pdfbar">
                <select aria-label="Choose PDF" value={viewing.id} onChange={(e) => setViewSrc(e.target.value)}>
                  {doc.sources.map((s) => <option key={s.id} value={s.id}>{pretty(s.name)}</option>)}
                </select>
              </div>
            )}
            {viewing.has_pdf ? <iframe key={viewing.id} title="Original PDF" src={`/api/doc/${id}/pdf?source=${viewing.id}`} />
              : <p className="muted pad">The original PDF isn't stored for this document. Upload it again to use the viewer.</p>}
          </aside>
        )}
      </div>
    </>
  );
}

/* ---------- topic card grid ---------- */
function TopicGrid({ topics, docId, status, onExplain }) {
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState({}); // topic -> description (null while loading)

  async function pick(t) {
    setSel(sel === t ? null : t);
    if (sel === t || notes[t] !== undefined) return;
    setNotes((n) => ({ ...n, [t]: null }));
    try {
      const r = await api("/api/topic/describe", { body: { doc_id: docId, topic: t } });
      setNotes((n) => ({ ...n, [t]: r.note || "" }));
    } catch { setNotes((n) => ({ ...n, [t]: "" })); }
  }

  if (!topics.length) return <p className="muted">{status === "building" ? "Finding key topics…" : "Type a question below to get started."}</p>;
  const list = topics.map((t, i) => ({ t, i })).filter(({ t }) => t.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="topics">
      <div className="thead">
        <div>
          <h3>Key topics</h3>
          <p className="muted">Select a topic to preview it, then press Explain.</p>
        </div>
        {topics.length > 6 && (
          <div className="tsearch">
            <Icon n="search" size={15} />
            <input value={q} placeholder="Search topics…" aria-label="Search topics" onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
      </div>
      <div className="tgrid">
        {list.map(({ t, i }) => {
          const on = sel === t;
          return (
            <div key={t} className={"tcard" + (on ? " on" : "")} style={{ "--c": HUES[i % HUES.length] }}>
              <button className="tpick" aria-pressed={on} onClick={() => pick(t)}>
                <span className="tnum">{String(i + 1).padStart(2, "0")}</span>
                <span className="ttitle">{t}</span>
              </button>
              {on && (
                <div className="tbody">
                  {notes[t] === null ? <div className="skels" aria-label="Loading description"><i /><i /></div>
                    : <p className="tdesc">{notes[t] || "Explain this topic using your document."}</p>}
                  <button className="btn primary sm" onClick={() => onExplain(t)}>Explain topic</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!list.length && <p className="muted">No topics match “{q}”.</p>}
    </div>
  );
}

function Learn({ doc }) {
  const [msgs, setMsgs] = useState(doc.messages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null);
  const [pop, setPop] = useState(null);
  const [cfg, setCfg] = useState({ style: "simple language", length: "medium", custom: "" });
  const end = useRef();
  const [threadRef, gutter] = useGutter();
  useEffect(() => { end.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" }); }, [msgs, busy]);

  const push = (m) => setMsgs((x) => [...x, m]);
  const lastAi = msgs.map((m) => m.role).lastIndexOf("assistant");
  const patchLast = (text) => setMsgs((x) => x.map((m, k) => (k === x.length - 1 ? { ...m, text } : m)));
  async function run(url, body, role) {
    push({ role, text: "" }); setBusy(true);
    try { await stream(url, body, patchLast); }
    catch (e) { setMsgs((x) => [...x.slice(0, -1), { role: "error", text: e.message }]); }
    setBusy(false);
  }
  async function ask(topic = input) {
    if (!topic.trim() || busy) return;
    setInput(""); setPop(null); push({ role: "user", text: topic });
    await run("/api/explain/stream", { doc_id: doc.id, topic, ...cfg }, "assistant");
  }
  async function transform(mode, idx) {
    const text = msgs[idx].text; setSel(null);
    await run("/api/transform/stream", { doc_id: doc.id, text, mode }, mode === "sticky" ? "sticky" : "assistant");
  }
  async function clear() {
    if (!confirm("Clear this conversation? Explanations and sticky notes will also be removed from exported notes.")) return;
    try { await api(`/api/messages/${doc.id}`, { method: "DELETE" }); setMsgs([]); setSel(null); }
    catch (e) { push({ role: "error", text: e.message }); }
  }

  return (
    <section className="learn" style={gutter}>
      <div className="tools"><button className="btn ghost sm" disabled={!msgs.length || busy} onClick={clear}>Clear chat</button></div>
      <div className="thread" ref={threadRef}><div className="col">
        {!msgs.length && <TopicGrid topics={doc.topics} docId={doc.id} status={doc.status} onExplain={ask} />}
        {msgs.map((m, i) =>
          m.role === "user" ? <div key={i} className="bubble me">{m.text}</div>
          : m.role === "error" ? <div key={i} className="bubble err">{m.text}</div>
          : m.role === "sticky" ? (
            <div key={i} className="notes">
              {(m.text || "Thinking…").split(/\n-{3,}\n?/).filter((x) => x.trim()).map((t, k) => <div key={k}>{t.trim()}</div>)}
            </div>
          ) : (
            <div key={i} className={"bubble ai" + (sel === i ? " sel" : "")} onClick={() => setSel(sel === i ? null : i)}>
              <MD>{m.text || "Thinking…"}</MD>
              {(sel === i || i === lastAi) && !(busy && i === msgs.length - 1) && (
                <div className="actions" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => transform("summarize", i)}>Summarize</button>
                  <button onClick={() => transform("sticky", i)}>Sticky notes</button>
                  <button onClick={() => transform("memorize", i)}>Help me memorize</button>
                </div>
              )}
            </div>
          )
        )}
        <div ref={end} />
        </div>
      </div>
      <Composer value={input} onChange={setInput} onSend={() => ask()} busy={busy}
        placeholder="Ask about any topic…" sendLabel="Explain"
        popup={<>
          {pop === "topics" && <div className="pop chips">{doc.topics.map((t) => <button key={t} onClick={() => ask(t)}>{t}</button>)}</div>}
          {pop === "custom" && (
            <div className="pop form">
              <label>Style
                <select value={cfg.style} onChange={(e) => setCfg({ ...cfg, style: e.target.value })}>
                  {["simple language", "technical terminology", "professional tone", "conversational, with examples"].map((s) => <option key={s}>{s}</option>)}
                </select></label>
              <label>Length
                <select value={cfg.length} onChange={(e) => setCfg({ ...cfg, length: e.target.value })}>
                  {["short", "medium", "detailed"].map((s) => <option key={s}>{s}</option>)}
                </select></label>
              <label className="wide">Further customization
                <textarea rows="2" value={cfg.custom} placeholder="e.g. use bullet points, add an analogy" onChange={(e) => setCfg({ ...cfg, custom: e.target.value })} /></label>
            </div>
          )}
        </>}
        extras={<>
          <button className={"pill" + (pop === "topics" ? " on" : "")} aria-expanded={pop === "topics"} onClick={() => setPop(pop === "topics" ? null : "topics")}>Topics</button>
          <button className={"pill" + (pop === "custom" ? " on" : "")} aria-expanded={pop === "custom"} onClick={() => setPop(pop === "custom" ? null : "custom")}>Customize</button>
        </>} />
    </section>
  );
}

function Chat({ doc }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef();
  const [threadRef, gutter] = useGutter();
  useEffect(() => { api(`/api/chat/${doc.id}`).then(setMsgs).catch(() => {}); }, [doc.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" }); }, [msgs, busy]);

  async function send(text = input) {
    if (!text.trim() || busy) return;
    setInput(""); setBusy(true);
    setMsgs((x) => [...x, { role: "user", text }, { role: "assistant", text: "" }]);
    try {
      await stream("/api/chat/stream", { doc_id: doc.id, message: text },
        (t) => setMsgs((x) => x.map((m, k) => (k === x.length - 1 ? { ...m, text: t } : m))));
    } catch (e) { setMsgs((x) => [...x.slice(0, -1), { role: "error", text: e.message }]); }
    setBusy(false);
  }
  async function clear() {
    if (!confirm("Clear this conversation?")) return;
    await api(`/api/chat/${doc.id}`, { method: "DELETE" }); setMsgs([]);
  }
  const ideas = ["Summarize this document in five points", "What are the main conclusions?", "Explain the key terms in simple words"];

  return (
    <section className="learn" style={gutter}>
      <div className="tools"><button className="btn ghost sm" disabled={!msgs.length || busy} onClick={clear}>Clear chat</button></div>
      <div className="thread" ref={threadRef}><div className="col">
        {!msgs.length && (
          <div className="hero">
            <h3>Ask anything about this document</h3>
            <p className="muted">I remember the conversation, so follow-up questions work.</p>
            <div className="chips">{ideas.map((t) => <button key={t} onClick={() => send(t)}>{t}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? <div key={i} className="bubble me">{m.text}</div>
          : m.role === "error" ? <div key={i} className="bubble err">{m.text}</div>
          : <div key={i} className="bubble ai static"><MD>{m.text || "Thinking…"}</MD></div>
        )}
        <div ref={end} />
      </div></div>
      <Composer value={input} onChange={setInput} onSend={() => send()} busy={busy}
        placeholder="Ask a question about the document…" sendLabel="Send" />
    </section>
  );
}

const answerOf = (x) => (!x.type || x.type === "mcq" || x.type === "tf" ? x.options[x.answer] : (x.answer_text || "").split("|")[0].trim());
const TYPES = [["mcq", "Multiple choice"], ["tf", "True / false"], ["fill", "Fill in the blank"], ["short", "Short answer"]];
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Quiz({ doc, reload }) {
  const [cfg, setCfg] = useState({ n: 10, difficulty: "medium", topic: "", types: ["mcq"], mode: "practice", minutes: 15 });
  const [q, setQ] = useState(null);
  const [left, setLeft] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState(null);
  const [text, setText] = useState("");
  const [res, setRes] = useState(null);
  const [grading, setGrading] = useState(false);
  const [deep, setDeep] = useState("");
  const [saved, setSaved] = useState(false);
  const fetching = useRef(false), pending = useRef([]), finishing = useRef(false);

  const resetQ = () => { setPick(null); setText(""); setRes(null); setDeep(""); setSaved(false); };
  const begin = (r) => {
    pending.current = []; finishing.current = false; resetQ(); setResults(null);
    setQ({ id: r.quiz_id, total: r.total, qs: r.questions, i: 0, answered: 0, score: 0, mode: r.mode || "practice" });
    setLeft(r.seconds_left ?? null);
  };
  async function start() {
    setLoading(true); setErr("");
    try { begin(await api("/api/quiz/start", { body: { doc_id: doc.id, ...cfg, minutes: cfg.mode === "exam" ? cfg.minutes : 0 } })); }
    catch (e) { setErr(e.message); }
    setLoading(false);
  }
  async function retry() {
    setLoading(true); setErr("");
    try { begin(await api("/api/quiz/retry", { body: { doc_id: doc.id } })); } catch (e) { setErr(e.message); }
    setLoading(false);
  }
  async function showResults(id) { try { setResults(await api(`/api/quiz/${id}/results`)); } catch (e) { setErr(e.message); } }
  async function open(id) {
    try {
      const r = await api(`/api/quiz/${id}`);
      if (r.over) return showResults(id);
      pending.current = []; finishing.current = false; resetQ(); setResults(null);
      setQ({ id, total: r.total, qs: r.questions, i: r.answered, answered: r.answered, score: r.score, mode: r.mode });
      setLeft(r.seconds_left);
    } catch (e) { setErr(e.message); }
  }
  // Background generation of the next batch (practice mode)
  async function more(s) {
    if (fetching.current || s.qs.length >= s.total) return;
    fetching.current = true;
    try {
      const r = await api(`/api/quiz/${s.id}/more`, { method: "POST", body: {} });
      setQ((p) => (p && p.id === s.id ? { ...p, qs: [...p.qs, ...r.questions], total: r.total ?? p.total } : p));
    } catch { /* retry button shown if the user runs out of questions */ }
    fetching.current = false;
  }
  useEffect(() => { if (q && q.mode !== "exam" && q.i < q.total && !q.qs[q.i]) more(q); }, [q?.i, q?.qs.length]);

  // Exam timer
  useEffect(() => {
    if (!q || q.mode !== "exam" || results || left === null) return;
    const t = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(t);
  }, [q?.id, results, left === null]);
  useEffect(() => { if (q?.mode === "exam" && !results && left !== null && left <= 0) finishExam(); }, [left]);

  const post = (payload) => {
    const p = api(`/api/quiz/${q.id}/answer`, { body: { index: q.i, ...payload } });
    pending.current.push(p.catch(() => {}));
    return p;
  };
  async function finishExam() {
    if (finishing.current || !q) return;
    finishing.current = true;
    await Promise.allSettled(pending.current);
    try { await api(`/api/quiz/${q.id}/finish`, { method: "POST", body: {} }); await showResults(q.id); }
    catch (e) { setErr(e.message); finishing.current = false; }
  }

  const cur = q?.qs[q.i];
  function bump(ok) {
    const s = { ...q, answered: q.answered + 1, score: q.score + (ok ? 1 : 0) };
    setQ(s);
    if (s.answered >= 0.65 * s.qs.length) more(s); // fetch next batch at ~65%
  }
  async function answer(payload) { // practice: check right away
    if (res || grading) return;
    const type = cur.type || "mcq";
    if (type === "mcq" || type === "tf") {
      const ok = payload.picked === cur.answer;
      setPick(payload.picked); setRes({ correct: ok }); bump(ok); post(payload).catch(() => {});
    } else {
      setGrading(true);
      try { const r = await post(payload); setRes({ correct: r.correct, feedback: r.feedback }); bump(r.correct); }
      catch (e) { setErr(e.message); }
      setGrading(false);
    }
  }
  function examNext() { // exam: save the answer (or a skip) and move on, no feedback
    const type = cur.type || "mcq";
    post(type === "fill" || type === "short" ? { text } : { picked: pick }).catch(() => {});
    if (q.i + 1 >= q.total) return finishExam();
    resetQ(); setQ({ ...q, i: q.i + 1, answered: q.answered + 1 });
  }
  const next = () => { resetQ(); setQ({ ...q, i: q.i + 1 }); };
  const exit = () => { setQ(null); setResults(null); reload(); };
  const toggleType = (k) => {
    const t = cfg.types.includes(k) ? cfg.types.filter((x) => x !== k) : [...cfg.types, k];
    if (t.length) setCfg({ ...cfg, types: t });
  };

  if (results) {
    const pct = results.total ? Math.round((100 * results.score) / results.total) : 0;
    const mine = (it) => ((it.question.type || "mcq") === "mcq" || it.question.type === "tf" ? it.question.options[it.picked] : it.text);
    return (
      <section className="card">
        <h3>{results.mode === "exam" ? "Exam results" : "Quiz results"}</h3>
        <p className="big">{results.score} / {results.total} <span className="muted">({pct}%)</span></p>
        <h4>By topic</h4>
        {results.topics.map((t) => (
          <div key={t.topic} className="trow"><span>{t.topic}</span><div className="bar2"><i style={{ width: `${(100 * t.correct) / t.total}%` }} /></div><b>{t.correct}/{t.total}</b></div>
        ))}
        <h4>Question review</h4>
        {results.items.map((it, k) => (
          <div key={k} className={"rev " + (it.correct ? "ok" : "no")}>
            <b>{k + 1}. {it.question.question}</b>
            <p>Your answer: {it.answered ? mine(it) : "none"} · {it.correct ? "Correct" : it.answered ? "Wrong" : "Skipped"}</p>
            {!it.correct && <p>Correct answer: {answerOf(it.question)}</p>}
            {it.feedback && <p className="muted">{it.feedback}</p>}
            <p className="muted">{it.question.explanation}</p>
          </div>
        ))}
        <button className="btn primary" onClick={exit}>Done</button>
      </section>
    );
  }

  if (!q) return (
    <>
    <PageHead title="Quiz" sub="Practise with instant feedback, or take a timed exam." />
    <section className="card setup">
      <div className="seg">
        {[["practice", "Practice"], ["exam", "Exam"]].map(([k, l]) => <button key={k} className={cfg.mode === k ? "on" : ""} onClick={() => setCfg({ ...cfg, mode: k })}>{l}</button>)}
      </div>
      {cfg.mode === "exam" && (
        <label>Time limit (minutes)
          <input type="number" min="1" max="180" value={cfg.minutes} onChange={(e) => setCfg({ ...cfg, minutes: Math.max(1, +e.target.value || 1) })} />
          <span className="muted small">Timed, with no explanations until the end. All questions are prepared first, which can take a minute.</span>
        </label>
      )}
      <label>Number of questions <b>{cfg.n}</b>
        <input type="range" min="1" max="50" value={cfg.n} onChange={(e) => setCfg({ ...cfg, n: +e.target.value })} /></label>
      <div className="chips left">
        {TYPES.map(([k, l]) => <button key={k} className={cfg.types.includes(k) ? "on" : ""} onClick={() => toggleType(k)}>{l}</button>)}
      </div>
      <div className="seg">
        {["easy", "medium", "hard"].map((d) => <button key={d} className={cfg.difficulty === d ? "on" : ""} onClick={() => setCfg({ ...cfg, difficulty: d })}>{d}</button>)}
      </div>
      <label>Topic
        <select value={cfg.topic} onChange={(e) => setCfg({ ...cfg, topic: e.target.value })}>
          <option value="">Whole document</option>{doc.topics.map((t) => <option key={t}>{t}</option>)}
        </select></label>
      <button className="btn primary" disabled={loading} onClick={start}>
        {loading ? (cfg.mode === "exam" ? "Preparing your exam…" : "Generating questions…") : cfg.mode === "exam" ? "Start exam" : "Start quiz"}
      </button>
      {doc.missed > 0 && (
        <button className="btn ghost" disabled={loading} onClick={retry}>Review {doc.missed} missed question{doc.missed === 1 ? "" : "s"}</button>
      )}
      {err && <p className="err-text">{err}</p>}
      {doc.quizzes.length > 0 && (
        <div className="past"><h4>Previous quizzes</h4>
          {doc.quizzes.map((x) => (
            <div key={x.id} className="prow">
              <span>{x.mode === "exam" ? "Exam" : x.difficulty} · {x.topic || "whole document"} · {x.answered}/{x.total} answered · score {x.score}</span>
              {x.mode === "exam" ? <button className="btn ghost" onClick={() => open(x.id)}>{x.over ? "Results" : "Resume"}</button>
                : x.answered < x.total ? <button className="btn ghost" onClick={() => open(x.id)}>Resume</button>
                : <button className="btn ghost" onClick={() => showResults(x.id)}>Review</button>}
            </div>
          ))}
        </div>
      )}
    </section>
    </>
  );

  if (q.i >= q.total) return (
    <section className="card center-card">
      <h3>You scored {q.score} out of {q.answered}</h3>
      <div className="row" style={{ justifyContent: "center" }}>
        <button className="btn ghost" onClick={() => showResults(q.id)}>See breakdown</button>
        <button className="btn primary" onClick={exit}>New quiz</button>
      </div>
    </section>
  );

  if (!cur) return (
    <section className="card center-card">
      <p className="muted">Loading next questions…</p>
      <button className="btn ghost" onClick={() => more(q)}>Retry</button>
    </section>
  );

  const type = cur.type || "mcq", exam = q.mode === "exam", locked = !exam && !!res, last = q.i + 1 >= q.total;
  const hasAnswer = type === "fill" || type === "short" ? text.trim() : pick !== null;
  return (
    <section className="card">
      <div className="progress"><i style={{ width: `${(q.i / q.total) * 100}%` }} /></div>
      <div className="row between">
        <p className="muted">Question {q.i + 1} of {q.total}{!exam && cur.topic ? ` · ${cur.topic}` : ""}</p>
        {exam && left !== null && <span className={"timer" + (left < 60 ? " low" : "")}>{fmt(Math.max(0, left))}</span>}
      </div>
      <h3 className="qtext">{cur.question}</h3>
      {(type === "mcq" || type === "tf") && cur.options.map((o, k) => (
        <button key={k} disabled={locked}
          className={"opt" + (locked ? (k === cur.answer ? " right" : pick === k ? " wrong" : "") : exam && pick === k ? " sel" : "")}
          onClick={() => (exam ? setPick(k) : answer({ picked: k }))}>{o}</button>
      ))}
      {(type === "fill" || type === "short") && (
        <>
          {type === "short"
            ? <textarea className="fillin" rows="3" value={text} disabled={locked || grading} placeholder="Write your answer…" onChange={(e) => setText(e.target.value)} />
            : <input className="fillin" value={text} disabled={locked || grading} placeholder="Type the missing word or phrase" onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !exam && text.trim() && answer({ text })} />}
          {!exam && !res && <button className="btn primary" disabled={grading || !text.trim()} onClick={() => answer({ text })}>{grading ? "Checking…" : "Check answer"}</button>}
        </>
      )}
      {exam && <div className="row"><button className="btn primary" onClick={examNext}>{last ? "Submit exam" : hasAnswer ? "Next" : "Skip"}</button></div>}
      {err && <p className="err-text">{err}</p>}
      {!exam && res && (
        <div className="feedback">
          <p><b>{res.correct ? "Correct." : "Not quite."}</b> {res.feedback} {cur.explanation}</p>
          {!res.correct && (type === "fill" || type === "short") && <p className="muted">Answer: {answerOf(cur)}</p>}
          <div className="row">
            <button className="btn ghost" disabled={saved} onClick={async () => { await api("/api/saved", { body: { doc_id: doc.id, question: cur } }); setSaved(true); }}>{saved ? "Saved" : "Save question"}</button>
            <button className="btn ghost" onClick={async () => {
              setDeep("Thinking…");
              try { setDeep((await api("/api/explain", { body: { doc_id: doc.id, topic: cur.topic, length: "detailed", save: false, custom: `Explain in depth why "${answerOf(cur)}" is the answer to: ${cur.question}` } })).text); }
              catch (e) { setDeep(e.message); }
            }}>Deep explanation</button>
            <button className="btn primary" onClick={next}>{last ? "See results" : "Next"}</button>
          </div>
          {deep && <div className="bubble ai static"><MD>{deep}</MD></div>}
        </div>
      )}
    </section>
  );
}

function Cards({ doc, active, reload }) {
  const [stats, setStats] = useState(null);
  const [queue, setQueue] = useState([]);
  const [flip, setFlip] = useState(false);
  const [done, setDone] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");

  async function refresh() {
    const [s, q] = await Promise.all([api(`/api/cards/${doc.id}/stats`), api(`/api/cards/${doc.id}/due?limit=30`)]);
    setStats(s); setQueue(q); setFlip(false); setDone(0);
  }
  async function sync() {
    setSyncing(true); setMsg("");
    try {
      const r = await api("/api/cards/generate", { body: { doc_id: doc.id } });
      setMsg(r.added ? `Added ${r.added} new card${r.added === 1 ? "" : "s"}.` : "Cards are up to date.");
    } catch (e) { setMsg(e.message); }
    try { await refresh(); } catch (e) { setMsg(e.message); }
    setSyncing(false);
  }
  useEffect(() => { if (active) sync(); }, [active]);

  const card = queue[0];
  function rate(r) {
    if (!card || !flip) return;
    setFlip(false);
    api(`/api/cards/${card.id}/review`, { body: { rating: r } }).catch(() => {});
    setQueue((q) => (r === 0 ? [...q.slice(1), q[0]] : q.slice(1))); // "Again" returns later this session
    if (r !== 0) setDone((d) => d + 1);
    if (r !== 0 && queue.length === 1) { api(`/api/cards/${doc.id}/stats`).then(setStats); reload(); }
  }
  useEffect(() => {
    if (!active || !card) return;
    const onKey = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (!flip && (e.key === " " || e.key === "Enter")) { e.preventDefault(); setFlip(true); }
      else if (flip && "1234".includes(e.key) && e.key) rate(+e.key - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
    <PageHead title="Flashcards" sub="Review each card when it is due and it stays in memory longer." />
    <section className="card cards">
      <div className="row between">
        <div className="row">
          {stats && <><span className="tag">Due {stats.due}</span><span className="tag">New {stats.new}</span><span className="tag">Total {stats.total}</span></>}
        </div>
        <button className="btn ghost" disabled={syncing} onClick={sync}>{syncing ? "Syncing…" : "Sync cards"}</button>
      </div>
      {msg && <p className="muted small">{msg}</p>}
      {!stats ? <p className="muted">Loading…</p>
        : stats.total === 0 ? (
          <p className="muted">No cards yet. Save questions from a quiz or make sticky notes in Learn, then press Sync cards. They turn into flashcards that come back just before you'd forget them.</p>
        ) : !card ? (
          <div className="center-card">
            <h3>All caught up</h3>
            <p className="muted">{stats.next_due ? `Next cards are due on ${stats.next_due}.` : "Nothing is due right now."}</p>
          </div>
        ) : (
          <>
            <p className="muted">Card {done + 1} of {done + queue.length}{card.topic ? ` · ${card.topic}` : ""}</p>
            <div className="flash" onClick={() => setFlip(true)}>
              <MD>{card.front}</MD>
              {flip && <><hr /><div className="back"><MD>{card.back}</MD></div></>}
            </div>
            {!flip ? <button className="btn primary" onClick={() => setFlip(true)}>Show answer (Space)</button> : (
              <div className="rate">
                {["Again", "Hard", "Good", "Easy"].map((l, k) => <button key={l} className={"r" + k} onClick={() => rate(k)}>{l}<small>{k + 1}</small></button>)}
              </div>
            )}
          </>
        )}
    </section>
    </>
  );
}

function Progress({ doc, active }) {
  const [d, setD] = useState(null);
  useEffect(() => { if (active) api(`/api/dashboard/${doc.id}`).then(setD).catch(() => {}); }, [active]);
  if (!d) return <div className="card"><p className="muted">Loading…</p></div>;
  if (!d.answered && !d.cards.reviews) return <div className="card"><p className="muted">Take a quiz or review some flashcards and your progress will show up here.</p></div>;
  const ranked = d.topics.filter((t) => t.n >= 2).sort((a, b) => b.pct - a.pct);
  const half = Math.min(3, Math.ceil(ranked.length / 2));
  const strong = ranked.slice(0, half), weak = ranked.slice(half).reverse().slice(0, 3);
  const tiles = [[d.streak, "day streak"], [d.best_streak, "best streak"], [d.answered, "questions answered"],
    [d.accuracy == null ? "–" : d.accuracy + "%", "accuracy"], [`${d.cards.mastered}/${d.cards.total}`, "cards mastered"], [d.cards.due, "cards due"]];
  const W = 600, H = 150, pts = d.trend.map((t, k) => [d.trend.length > 1 ? 20 + (k * (W - 40)) / (d.trend.length - 1) : W / 2, H - 15 - (t.pct * (H - 30)) / 100, t]);
  const rows = (list) => list.map((t) => (
    <div key={t.topic} className="trow"><span>{t.topic}</span><div className="bar2"><i style={{ width: `${t.pct}%` }} /></div><b>{t.pct}%</b></div>
  ));
  return (
    <>
      <PageHead title="Your progress" sub="Streaks, scores and topics across quizzes and flashcards." />
      <div className="tiles">{tiles.map(([v, l]) => <div key={l} className="card tile"><b>{v}</b><span className="muted">{l}</span></div>)}</div>
      <div className="card">
        <h4>Quiz scores over time</h4>
        {pts.length ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Quiz scores over time">
            {[0, 50, 100].map((p) => <line key={p} x1="10" x2={W - 10} y1={H - 15 - (p * (H - 30)) / 100} y2={H - 15 - (p * (H - 30)) / 100} className="grid" />)}
            <polyline fill="none" className="line" points={pts.map((p) => p[0] + "," + p[1]).join(" ")} />
            {pts.map((p, k) => <g key={k}><circle cx={p[0]} cy={p[1]} r="4" className="dot" /><title>{`${p[2].date}: ${p[2].pct}% (${p[2].n} questions)`}</title></g>)}
          </svg>
        ) : <p className="muted">No quiz results yet.</p>}
      </div>
      <div className="card">
        <h4>Topics</h4>
        {ranked.length ? (
          <>
            <p className="muted small">Strongest</p>{rows(strong)}
            {weak.length > 0 && <><p className="muted small">Needs work</p>{rows(weak)}</>}
          </>
        ) : <p className="muted">Answer at least two questions in a topic to see how you're doing.</p>}
      </div>
      <div className="card">
        <h4>Last 14 days</h4>
        <div className="heat">{d.activity.map((x) => <i key={x.date} title={`${x.date}: ${x.n} activities`} style={{ opacity: x.n ? Math.min(1, 0.3 + x.n / 12) : 0.12 }} />)}</div>
      </div>
    </>
  );
}

function Saved({ doc, active }) {
  const [items, setItems] = useState([]);
  const load = () => api(`/api/saved?doc_id=${doc.id}`).then(setItems);
  useEffect(() => { if (active) load(); }, [active]);
  return (
    <>
      <PageHead title="Saved questions" sub="Questions you saved during quizzes. They also become flashcards." />
      {!items.length ? <div className="card"><p className="muted">No saved questions yet. Save one during a quiz.</p></div>
        : items.map((s) => (
          <div key={s.id} className="card saved">
            <b>{s.question}</b>
            <p>Answer: {answerOf(s)}</p>
            <p className="muted">{s.explanation}</p>
            <div className="row between"><span className="tag">{s.topic}</span>
              <button className="btn ghost" onClick={async () => { await api(`/api/saved/${s.id}`, { method: "DELETE" }); load(); }}>Remove</button></div>
          </div>
        ))}
    </>
  );
}