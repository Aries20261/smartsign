// Gaya halaman perantara shortlink (diporting dari Redirect.html).
export const GO_CSS = `:root{--p:#1d4ed8;--bg:#f5f6fa;--t:#0f172a;--m:#475569;--b:#e2e8f0;--ok:#0a7d33;--bad:#b42318;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4dc}
@media (prefers-color-scheme:dark){:root{--p:#6d9bff;--bg:#0f1115;--t:#eef0f4;--m:#b6bcc8;--b:#2b303b;--bad:#ff8a80;--bad-bg:#3a1a19;--warn:#f5c25b;--warn-bg:#352a12}.card{background:#171a21!important}input,select,textarea{background:#171a21;color:var(--t)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:#fff;border:1px solid var(--b);border-radius:14px;padding:22px;max-width:520px;width:100%;box-shadow:0 4px 16px rgba(0,0,0,.06)}
h1{font-size:1.25rem;margin:0 0 8px}.m{color:var(--m)}.small{font-size:.85rem}
.domain{font:700 1.15rem ui-monospace,Menlo,Consolas,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--b);border-radius:10px;padding:10px 12px;margin:10px 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 18px;border-radius:10px;border:1px solid var(--b);background:transparent;color:var(--t);font:600 1rem inherit;cursor:pointer;text-decoration:none;gap:8px}
.btn.p{background:var(--p);border-color:var(--p);color:#fff}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 12px;margin:10px 0}.bad{background:var(--bad-bg);color:var(--bad);border-radius:10px;padding:10px 12px}
input,select,textarea{width:100%;min-height:46px;padding:10px 12px;border:1px solid #94a3b8;border-radius:10px;font:inherit;margin:4px 0 10px}
label{font-weight:600;font-size:.9rem}:focus-visible{outline:3px solid var(--p);outline-offset:2px}
.spin{width:28px;height:28px;border:3px solid var(--b);border-top-color:var(--p);border-radius:50%;animation:s .8s linear infinite;margin:8px auto}@keyframes s{to{transform:rotate(360deg)}}
ul{margin:6px 0;padding-left:20px}[hidden]{display:none!important}`;
