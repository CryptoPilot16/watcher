#!/usr/bin/env python3
"""Long-running faster-whisper transcription sidecar.

Protocol: line-delimited JSON over stdin/stdout.
  request:  {"path": "/tmp/foo.ogg", "id": "<uuid>"}
  response: {"id": "<uuid>", "ok": true,  "text": "...", "durationMs": 123}
  response: {"id": "<uuid>", "ok": false, "error": "..."}

The model loads once on startup so subsequent transcriptions are fast.
"""

from __future__ import annotations

import json
import os
import sys
import time

MODEL_NAME = os.environ.get("WATCH_AXIOM_CEO_WHISPER_MODEL", "small.en")
DEVICE = os.environ.get("WATCH_AXIOM_CEO_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WATCH_AXIOM_CEO_WHISPER_COMPUTE", "int8")
LANGUAGE = os.environ.get("WATCH_AXIOM_CEO_WHISPER_LANGUAGE", "en")
BEAM_SIZE = int(os.environ.get("WATCH_AXIOM_CEO_WHISPER_BEAM", "1"))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        emit({"id": "boot", "ok": False, "error": f"faster_whisper import failed: {exc}"})
        return 1

    t0 = time.time()
    try:
        model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
    except Exception as exc:  # noqa: BLE001
        emit({"id": "boot", "ok": False, "error": f"model load failed: {exc}"})
        return 1
    emit({"id": "boot", "ok": True, "model": MODEL_NAME, "loadMs": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"id": "?", "ok": False, "error": f"bad json: {exc}"})
            continue

        req_id = req.get("id", "?")
        path = req.get("path")
        if not path or not os.path.exists(path):
            emit({"id": req_id, "ok": False, "error": f"file not found: {path}"})
            continue

        t0 = time.time()
        try:
            segments, _info = model.transcribe(
                path,
                language=LANGUAGE,
                beam_size=BEAM_SIZE,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            emit({
                "id": req_id,
                "ok": True,
                "text": text,
                "durationMs": int((time.time() - t0) * 1000),
            })
        except Exception as exc:  # noqa: BLE001
            emit({"id": req_id, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
