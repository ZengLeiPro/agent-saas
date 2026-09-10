"""Raw NDJSON ingestion shared by the dedicated receiver and native tests."""
import os
from pathlib import Path
import uuid

from dws_spool import DwsSpool, FRAME_BYTES, SpoolError


def save_partial(path: Path, payload: bytes) -> None:
    temporary = path.with_name(f".partial-{uuid.uuid4().hex}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


class DurableRawFrames:
    def __init__(self, spool: DwsSpool):
        self.spool = spool
        self.buffer = bytearray()
        self.partial_path = spool.directory / "partial-frame.bin"
        self.blocked = False
        self.reason = None

    def accept(self, data: bytes) -> None:
        if self.blocked:
            raise SpoolError("durable_acceptance_blocked")
        if len(data) > 64 * 1024:
            raise SpoolError("receiver_read_chunk_limit")
        self.buffer.extend(data)
        try:
            while b"\n" in self.buffer:
                line, _, tail = self.buffer.partition(b"\n")
                if len(line) > FRAME_BYTES:
                    raise SpoolError("source_frame_limit")
                # Do not parse or filter here. Invalid/blank/unsupported records
                # must reach the durable PG dead-letter decision before ACK.
                self.spool.append(bytes(line))
                self.buffer[:] = tail
            if len(self.buffer) > FRAME_BYTES:
                raise SpoolError("source_frame_limit")
            if self.buffer:
                save_partial(self.partial_path, bytes(self.buffer))
            elif self.partial_path.exists():
                self.partial_path.unlink()
        except (OSError, ValueError, SpoolError) as error:
            self.blocked = True
            self.reason = str(error) if isinstance(error, SpoolError) else "spool_persistence_unavailable"
            # At most one bounded read beyond a 1 MiB frame is retained locally.
            # On storage failure no later stdout bytes are consumed or discarded.
            save_partial(self.partial_path, bytes(self.buffer))
            raise

    def finish(self) -> bool:
        if self.buffer:
            save_partial(self.partial_path, bytes(self.buffer))
        return not self.blocked and not self.buffer
