"""Copy a desktop SubCast library into a fresh DSH data directory."""
import argparse
from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
import tempfile


def migrate(source, destination):
    source = source.resolve(strict=True)
    destination = destination.resolve()
    if destination.exists() or source in destination.parents:
        raise ValueError("Choose a new destination outside the desktop library.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        stage = Path(temp) / "library"
        stage.mkdir(mode=0o700)
        uri = (source / "subcast.db").as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as original, closing(sqlite3.connect(stage / "subcast.db")) as copy:
            original.backup(copy)
            for table in ("shows", "episodes", "transcripts", "blobs", "settings"):
                copy.execute(f"SELECT 1 FROM {table} LIMIT 1")
            if copy.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("SQLite integrity check failed.")
        for name in ("downloads", "models"):
            if (source / name).is_dir():
                shutil.copytree(source / name, stage / name, ignore=shutil.ignore_patterns("*.part", ".tmp-*", ".DS_Store"))
        if destination.exists():
            raise FileExistsError(destination)
        stage.rename(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    migrate(args.source, args.destination)
