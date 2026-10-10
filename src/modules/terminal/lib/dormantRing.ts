const DEFAULT_BYTE_CAP = 1024 * 1024;
const DEFAULT_BLOCK_SIZE = 16 * 1024;

// No \x1bc here: a full reset would erase the snapshot restored just before
// the drain, scrollback included.
const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\r\n\x1b[0m\x1b[2m[awei-work: some output was dropped while this tab was hidden]\x1b[0m\r\n",
);

const LF = 0x0a;

/**
 * Byte buffer for PTY output while a leaf has no renderer slot. Chunks are
 * coalesced into fixed-size blocks (capacity bound by bytes, not chunk
 * count); on overflow the oldest blocks are dropped and drain() resumes from
 * the next line boundary instead of resetting the terminal.
 */
export class DormantRing {
  private blocks: Uint8Array[] = [];
  private head = 0;
  private tailLen = 0;
  private total = 0;
  private overflowed = false;

  constructor(
    private readonly byteCap = DEFAULT_BYTE_CAP,
    private readonly blockSize = DEFAULT_BLOCK_SIZE,
  ) {}

  push(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.blocks[this.blocks.length - 1];
      if (this.blocks.length === this.head || this.tailLen === tail.length) {
        tail = new Uint8Array(this.blockSize);
        this.blocks.push(tail);
        this.tailLen = 0;
      }
      const n = Math.min(tail.length - this.tailLen, bytes.length - offset);
      tail.set(bytes.subarray(offset, offset + n), this.tailLen);
      this.tailLen += n;
      this.total += n;
      offset += n;

      while (this.total > this.byteCap && this.blocks.length - this.head > 1) {
        this.total -= this.blocks[this.head].length;
        this.head++;
        this.overflowed = true;
      }
    }
    if (this.head > 16 && this.head > this.blocks.length / 2) {
      this.blocks = this.blocks.slice(this.head);
      this.head = 0;
    }
  }

  /** Emit the buffered bytes without consuming them. The web bridge seeds a
   *  phone from this leaf's snapshot plus whatever has arrived since, and the
   *  desktop still has to render those same bytes when the pane comes back. */
  peek(write: (bytes: Uint8Array) => void): void {
    this.emit(write);
  }

  drain(write: (bytes: Uint8Array) => void): void {
    this.emit(write);
    this.blocks = [];
    this.head = 0;
    this.tailLen = 0;
    this.total = 0;
    this.overflowed = false;
  }

  private emit(write: (bytes: Uint8Array) => void): void {
    const last = this.blocks.length - 1;
    let seekLine = this.overflowed;
    if (this.overflowed && this.head <= last) {
      write(OVERFLOW_NOTICE);
    }
    for (let i = this.head; i <= last; i++) {
      const len = i === last ? this.tailLen : this.blocks[i].length;
      let start = 0;
      if (seekLine) {
        const lf = this.blocks[i].subarray(0, len).indexOf(LF);
        if (lf < 0) continue;
        start = lf + 1;
        seekLine = false;
      }
      if (start < len) write(this.blocks[i].subarray(start, len));
    }
  }

  byteLength(): number {
    return this.total;
  }
}
