"""
Photo Sequencer — local web app (Version 2: three trays).

Sort & cull a large photo folder down to a target count, sequencing and
eliminating at the same time. Images stay on disk: the browser never uploads
anything. This Flask backend reads the folder the user picks, serves cached
thumbnails and compressed previews, and persists everything in a per-session JSON file so a refresh
(or coming back to the same URL later) restores the full curation state.

Sessions:
    Opening a folder creates a session with a short id and a shareable URL:
        http://127.0.0.1:5000/session/<id>
    All state for that session lives in  sessions/<id>.json  and is restored
    whenever that URL is loaded.

Run:
    pip install flask pillow
    python app.py
Then open http://127.0.0.1:5000
"""

from __future__ import annotations

import json
import secrets
import shutil
import threading
from datetime import datetime
from pathlib import Path

from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   send_file, send_from_directory)

try:
    from PIL import Image, ImageOps
    from PIL.ExifTags import IFD
except ImportError:  # pragma: no cover
    raise SystemExit("Pillow is required. Install with:  pip install pillow")

app = Flask(__name__)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".heic"}
THUMB_DIR = ".photo-sequencer-thumbs"         # thumbnail cache inside the chosen folder
PREVIEW_DIR = ".photo-sequencer-previews"     # preview cache inside the chosen folder
THUMB_MAX = 144                               # px, longest edge (2× the 72px strip cells)
THUMB_QUALITY = 72
PREVIEW_MAX = 1280                            # px, longest edge — enough for on-screen review
PREVIEW_QUALITY = 78
STATE_VERSION = 2

APP_DIR = Path(__file__).resolve().parent
SESSIONS_DIR = APP_DIR / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)

_lock = threading.Lock()                       # guards session file writes


# --------------------------------------------------------------------------- #
# Filesystem helpers
# --------------------------------------------------------------------------- #
def is_image(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_EXTS


def list_images(folder: Path):
    """Image filenames directly inside *folder*, sorted case-insensitively."""
    try:
        names = [f.name for f in folder.iterdir()
                 if f.is_file() and is_image(f.name)]
    except (PermissionError, FileNotFoundError):
        return []
    names.sort(key=lambda s: s.lower())
    return names


# EXIF tag ids — DateTimeOriginal lives in the Exif sub-IFD, not the root IFD.
_EXIF_ORIGINAL = 36867      # DateTimeOriginal
_EXIF_DIGITIZED = 36868     # DateTimeDigitized
_EXIF_DATETIME = 306        # DateTime
_EXIF_SUBSEC_ORIGINAL = 37521
UPLOAD_SORT_VERSION = 2     # bump to re-sort sessions sorted with the old logic


def _parse_exif_datetime(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", errors="ignore")
        except Exception:
            return None
    if not isinstance(value, str):
        return None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def _subsec_sort_key(value) -> int:
    if value is None:
        return 0
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", errors="ignore")
        except Exception:
            return 0
    digits = "".join(c for c in str(value) if c.isdigit())
    return int(digits[:6]) if digits else 0


def _read_exif_capture_key(exif) -> tuple[datetime, int] | None:
    """Return (datetime, subsec) from EXIF, matching exiftool DateTimeOriginal."""
    if not exif:
        return None
    ifds = [exif]
    try:
        ifds.append(exif.get_ifd(IFD.Exif))
    except Exception:
        pass

    for ifd in ifds:
        dt = _parse_exif_datetime(ifd.get(_EXIF_ORIGINAL))
        if dt:
            return dt, _subsec_sort_key(ifd.get(_EXIF_SUBSEC_ORIGINAL))

    for ifd in ifds:
        for tag in (_EXIF_DIGITIZED, _EXIF_DATETIME):
            dt = _parse_exif_datetime(ifd.get(tag))
            if dt:
                return dt, 0
    return None


def image_capture_datetime(path: Path) -> datetime:
    """Best capture timestamp for sorting: DateTimeOriginal → other EXIF → mtime."""
    try:
        with Image.open(path) as im:
            key = _read_exif_capture_key(im.getexif())
            if key:
                return key[0]
    except Exception:
        pass
    try:
        return datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        return datetime.min


def image_capture_sort_key(path: Path) -> tuple:
    try:
        with Image.open(path) as im:
            key = _read_exif_capture_key(im.getexif())
            if key:
                return (key[0], key[1], path.name.lower())
    except Exception:
        pass
    try:
        return (datetime.fromtimestamp(path.stat().st_mtime), 0, path.name.lower())
    except OSError:
        return (datetime.min, 0, path.name.lower())


def sort_names_by_capture_time(folder: Path, names: list[str]) -> list[str]:
    return sorted(names, key=lambda n: image_capture_sort_key(folder / n))


def ensure_upload_order(sess: dict, folder: Path, names: list[str]) -> bool:
    """
    Persist capture-time order as decision['u'] (uploadIndex) once per session.
    New files discovered later are appended after the existing order, sorted
    among themselves by capture time.
    """
    decisions = sess.setdefault("decisions", {})
    changed = False

    if sess.get("upload_sort") == UPLOAD_SORT_VERSION:
        missing = [n for n in names if "u" not in decisions.get(n, {})]
        if not missing:
            return False
        max_u = max((d.get("u", -1) for d in decisions.values()), default=-1)
        for i, name in enumerate(sort_names_by_capture_time(folder, missing),
                                 start=max_u + 1):
            decisions.setdefault(name, {})["u"] = i
        return True

    for i, name in enumerate(sort_names_by_capture_time(folder, names)):
        decisions.setdefault(name, {})["u"] = i
        changed = True
    sess["upload_sort"] = UPLOAD_SORT_VERSION
    return changed


# --------------------------------------------------------------------------- #
# Session storage
# --------------------------------------------------------------------------- #
def new_session_id() -> str:
    """Short, URL-safe, collision-checked id."""
    while True:
        sid = secrets.token_urlsafe(5).replace("_", "").replace("-", "")[:8].lower()
        if sid and not session_path(sid).exists():
            return sid


def session_path(sid: str) -> Path:
    # keep ids to a safe charset so they can't escape the sessions dir
    safe = "".join(c for c in sid if c.isalnum())
    if not safe:
        abort(400, description="Invalid session id")
    return SESSIONS_DIR / f"{safe}.json"


def load_session(sid: str) -> dict:
    p = session_path(sid)
    if not p.exists():
        abort(404, description="Session not found")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        abort(500, description="Session file is corrupt")


def save_session(sid: str, data: dict) -> None:
    data["version"] = STATE_VERSION
    with _lock:
        tmp = session_path(sid).with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(session_path(sid))


def session_folder(sid: str) -> Path:
    folder = Path(load_session(sid).get("folder", ""))
    if not folder.is_dir():
        abort(410, description="The folder for this session is no longer available")
    return folder


def build_photo_list(sid: str) -> dict:
    """
    Merge on-disk images with the session's saved decisions into the UI payload.

    Each photo: {name, status, mark, flagged, order, uploadIndex}
      status: 'seq' (selected) | 'src' (all uploaded / undecided) | 'cut' (rejected)
      uploadIndex: persisted capture-time order (EXIF DateTimeOriginal, set once)
    New files (not yet in the session) default to 'src' so they surface for review.
    """
    sess = load_session(sid)
    folder = Path(sess.get("folder", ""))
    names = list_images(folder)
    if ensure_upload_order(sess, folder, names):
        save_session(sid, sess)
    decisions = sess.get("decisions", {})

    photos = []
    for i, name in enumerate(names):
        d = decisions.get(name, {})
        status = d.get("s")
        if status not in ("seq", "src", "cut"):
            status = "src"
        photos.append({
            "name": name,
            "status": status,
            "mark": d.get("m") if d.get("m") in ("flag", "star") else None,
            "flagged": bool(d.get("f", False)),
            "order": d.get("o", 10 ** 9),
            "uploadIndex": d.get("u", i),
        })

    photos.sort(key=lambda p: (p["order"], p["uploadIndex"]))
    return {
        "session": sid,
        "folder": str(folder),
        "folder_ok": folder.is_dir(),
        "target": sess.get("target", 500),
        "photos": photos,
        "count": len(photos),
    }


# --------------------------------------------------------------------------- #
# Image cache (thumbnails + previews)
# --------------------------------------------------------------------------- #
def _cache_dir(folder: Path, subdir: str) -> Path:
    d = folder / subdir
    d.mkdir(exist_ok=True)
    return d


def _cache_key(name: str, st) -> str:
    return f"{Path(name).stem}_{int(st.st_mtime)}_{st.st_size}.jpg"


def _make_jpeg(src: Path, dst: Path, max_edge: int, quality: int,
               resample=Image.Resampling.BILINEAR) -> bool:
    """Downscale *src* to a cached JPEG. Returns False on failure."""
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            # draft() asks decoders to skip pixels we won't need (big win on Pi)
            if max(im.size) > max_edge * 2:
                im.draft("RGB", (max_edge, max_edge))
            im.thumbnail((max_edge, max_edge), resample)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(dst, "JPEG", quality=quality, optimize=True, subsampling=2)
        return True
    except Exception:
        return False


def _get_cached_image(folder: Path, name: str, subdir: str,
                      max_edge: int, quality: int,
                      resample=Image.Resampling.BILINEAR) -> Path:
    src = folder / name
    if not src.exists():
        abort(404)
    cache = _cache_dir(folder, subdir)
    st = src.stat()
    dst = cache / _cache_key(name, st)
    if dst.exists():
        return dst
    if _make_jpeg(src, dst, max_edge, quality, resample):
        return dst
    return src


def get_thumbnail(folder: Path, name: str) -> Path:
    return _get_cached_image(folder, name, THUMB_DIR, THUMB_MAX, THUMB_QUALITY)


def get_preview(folder: Path, name: str) -> Path:
    return _get_cached_image(folder, name, PREVIEW_DIR, PREVIEW_MAX, PREVIEW_QUALITY,
                             Image.Resampling.BILINEAR)


# --------------------------------------------------------------------------- #
# Routes: page
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/session/<sid>")
def session_page(sid):
    # Same SPA; the frontend reads the id from the URL and restores state.
    return render_template("index.html")


@app.route("/static/<path:fn>")
def static_files(fn):
    return send_from_directory(app.static_folder, fn)


# --------------------------------------------------------------------------- #
# Routes: folder browsing (native picker replacement)
# --------------------------------------------------------------------------- #
@app.route("/api/browse")
def api_browse():
    raw = request.args.get("path", "")
    base = Path(raw).expanduser() if raw else Path.home()
    try:
        base = base.resolve()
    except OSError:
        base = Path.home()
    if not base.is_dir():
        base = Path.home()

    dirs = []
    try:
        for entry in sorted(base.iterdir(), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                dirs.append(entry.name)
    except PermissionError:
        pass

    parent = str(base.parent) if base.parent != base else None
    return jsonify({
        "path": str(base),
        "parent": parent,
        "dirs": dirs,
        "image_count": len(list_images(base)),
    })


# --------------------------------------------------------------------------- #
# Routes: sessions
# --------------------------------------------------------------------------- #
@app.route("/api/open", methods=["POST"])
def api_open():
    """Select a folder → create a new session and return its state + id."""
    data = request.get_json(force=True)
    folder = Path(data.get("path", "")).expanduser()
    try:
        folder = folder.resolve()
    except OSError:
        abort(400, description="Invalid path")
    if not folder.is_dir():
        abort(400, description="Not a directory")

    sid = new_session_id()
    save_session(sid, {"folder": str(folder), "target": 500, "decisions": {}})
    return jsonify(build_photo_list(sid))


@app.route("/api/session/<sid>")
def api_session(sid):
    """Restore an existing session (used on page load / refresh)."""
    return jsonify(build_photo_list(sid))


@app.route("/api/sessions")
def api_sessions():
    """List known sessions (for a 'recent' list on the picker)."""
    out = []
    for p in sorted(SESSIONS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        dec = s.get("decisions", {})
        selected = sum(1 for d in dec.values() if d.get("s") == "seq")
        out.append({
            "session": p.stem,
            "folder": s.get("folder", ""),
            "folder_ok": Path(s.get("folder", "")).is_dir(),
            "target": s.get("target", 500),
            "selected": selected,
            "decided": len(dec),
        })
    return jsonify({"sessions": out})


@app.route("/api/save", methods=["POST"])
def api_save():
    """Persist the full decision set for a session."""
    data = request.get_json(force=True)
    sid = data.get("session")
    if not sid:
        abort(400, description="Missing session id")
    sess = load_session(sid)                      # validates existence

    decisions = {}
    prev = sess.get("decisions", {})
    for i, p in enumerate(data.get("photos", [])):
        old = prev.get(p["name"], {})
        entry = {
            "o": i,
            "s": p.get("status", "src"),
            "m": p.get("mark"),
            "f": bool(p.get("flagged", False)),
        }
        if "u" in old:
            entry["u"] = old["u"]
        decisions[p["name"]] = entry
    sess["decisions"] = decisions
    sess["target"] = data.get("target", sess.get("target", 500))
    save_session(sid, sess)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Routes: images (session-scoped)
# --------------------------------------------------------------------------- #
@app.route("/api/thumb/<sid>/<path:name>")
def api_thumb(sid, name):
    folder = session_folder(sid)
    if not is_image(name):
        abort(404)
    return send_file(get_thumbnail(folder, name), mimetype="image/jpeg", max_age=86400)


@app.route("/api/preview/<sid>/<path:name>")
def api_preview(sid, name):
    folder = session_folder(sid)
    if not is_image(name):
        abort(404)
    return send_file(get_preview(folder, name), mimetype="image/jpeg", max_age=86400)


@app.route("/api/full/<sid>/<path:name>")
def api_full(sid, name):
    """Original file on disk (export / download only — not used in the UI)."""
    folder = session_folder(sid)
    src = folder / name
    if not src.exists() or not is_image(name):
        abort(404)
    return send_file(src, max_age=3600)


# --------------------------------------------------------------------------- #
# Routes: export
# --------------------------------------------------------------------------- #
@app.route("/api/export", methods=["POST"])
def api_export():
    data = request.get_json(force=True)
    sid = data.get("session")
    if not sid:
        abort(400, description="Missing session id")
    folder = session_folder(sid)
    ordered = data.get("selected", [])
    mode = data.get("mode", "copy")

    out = folder / "_selected_sequence"
    out.mkdir(exist_ok=True)

    lines = [f"# Photo Sequence Export — {len(ordered)} photos", ""]
    pad = max(4, len(str(len(ordered))))
    copied = 0
    for i, name in enumerate(ordered, 1):
        src = folder / name
        lines.append(f"{str(i).zfill(pad)}\t{name}")
        if mode == "copy" and src.exists():
            try:
                shutil.copy2(src, out / f"{str(i).zfill(pad)}_{name}")
                copied += 1
            except OSError:
                pass

    (out / "sequence.txt").write_text("\n".join(lines), encoding="utf-8")
    return jsonify({"ok": True, "out": str(out), "copied": copied,
                    "total": len(ordered), "mode": mode})


if __name__ == "__main__":
    print("\n  📷 Photo Sequencer running at  http://127.0.0.1:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
