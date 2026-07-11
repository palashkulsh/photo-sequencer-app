# Photo Sequencer (local web app)

Sort and cull a large photo folder down to a target count, sequencing and
eliminating at the same time — the V2 "three trays" workflow, now as real
software. Photos are **read directly from disk**; nothing is uploaded.

## What it does

- Pick a local folder in the in-app browser (no OS upload dialog).
- Photos load into three trays: **Selected sequence**, **All uploaded**, **Reject**.
- Drag a photo up to select (and order it) or down to reject. A photo lives in
  exactly one tray.
- In **All uploaded**, the orange **Flag** and yellow **Star** are reference-only
  markers (tag the thumbnail, move nothing).
- Decisions **auto-save** into `.photo-sequencer.json` inside the folder.
- **Export** copies the final selected photos, numbered by position, into a new
  `_selected_sequence/` folder (or writes just a `sequence.txt` manifest).

## Setup & run

```bash
cd photo-sequencer-app
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5000> and choose a folder.

## Notes

- Thumbnails are generated with Pillow and cached in `.photo-sequencer-thumbs/`
  inside the folder (safe to delete; regenerated on demand).
- Runs on `127.0.0.1` only — it is a personal, local tool, not a public server.
- Handles thousands of images; thumbnails and lazy-loading keep it responsive.
