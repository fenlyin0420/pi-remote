// Pi → App file hand-off (`send_to_phone` tool + `file_get` handler).
//
// The mirror of the app's attachment upload: the phone sends images/text files
// to the Pi, this sends a file that already lives on the Pi's disk back to the
// phone. Same content-first rule as the upload path — what counts as an image
// or as text is decided by the BYTES, never by the name.
//
// Why the size cap is what it is: the relay accepts a 4 MiB outer envelope
// (`RELAY_MAX_CT_MIB`) measured on `ct`, which is Base64 of the inner JSON. So
// B original bytes → 4/3 B (inner) → 16/9 B (ct) ≈ 1.78 B, and 16/9·B ≤ 4 MiB
// gives B ≤ ~2.3 MB. We cap at 2 MiB and DOWNSCALE images to fit (the SDK's own
// `resizeImage`, Photon/WASM — no new dependency); anything that still doesn't
// fit rides the chunked path in `session/file_send.ts` instead, which is what
// makes an arbitrary file (PDF, archive, video, a 40 MB log) deliverable.
import { closeSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { FILE_SEND_MAX_BYTES } from "./file_send.js";
/** Hard ceiling for the bytes we put on the wire (see the module comment). */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Text ceiling. The content travels as base64 (not as a raw JSON string), so
 * escape-doubling no longer applies — but 1 MiB of text in a chat bubble is
 * already past anything readable on a phone, and it keeps the envelope small.
 */
export const ATTACHMENT_TEXT_MAX_BYTES = 1 * 1024 * 1024;
/** Longest edge after a downscale. The card renders at 300×220 CSS px, so even
 *  a 3× screen is covered with room to spare. */
export const ATTACHMENT_MAX_DIM = 1600;
export const SEND_TO_PHONE_TOOL = "send_to_phone";
export const ATTACHMENT_CUSTOM_TYPE = "remote-pi:attachment";
// ── content sniffing ─────────────────────────────────────────────────────────
/** Image magic we accept, keyed by the mime we report for it. */
const IMAGE_MIME_BY_MAGIC = [
    { mime: "image/png", matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mime: "image/jpeg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mime: "image/gif", matches: (b) => b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a") },
    { mime: "image/webp", matches: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
    { mime: "image/bmp", matches: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];
/** The image mime for these bytes, or null when it isn't a supported image. */
export function _sniffImageMime(bytes) {
    for (const { mime, matches } of IMAGE_MIME_BY_MAGIC) {
        try {
            if (matches(bytes))
                return mime;
        }
        catch {
            // A truncated buffer throws inside some matchers; treat as "not this one".
        }
    }
    return null;
}
/**
 * Decode as text, or null when the bytes are not text.
 *
 * Same rules the app applies before accepting an upload: an explicit UTF-16 BOM
 * (mandatory there, since UTF-16 text usually decodes as valid UTF-8 by
 * accident), an optional UTF-8 BOM, otherwise strict UTF-8 with no NUL byte.
 * The check is on the content, so `Makefile`, `.gitignore` and a binary `.txt`
 * land on the right side of the line without any extension table.
 */
export function _decodeTextStrict(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return _decodeUtf16(bytes.subarray(2), true);
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return _decodeUtf16(bytes.subarray(2), false);
    }
    if (bytes.includes(0))
        return null;
    const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? bytes.subarray(3)
        : bytes;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(body);
    }
    catch {
        return null;
    }
}
/** UTF-16 with a mandatory BOM. `fatal` rejects lone surrogates, which is what
 *  keeps a mislabelled binary from decoding into plausible-looking mojibake. */
function _decodeUtf16(body, littleEndian) {
    if (body.length % 2 !== 0)
        return null;
    const buf = littleEndian ? body : Buffer.from(body).swap16();
    try {
        return new TextDecoder("utf-16le", { fatal: true }).decode(buf);
    }
    catch {
        return null;
    }
}
/** The mime we report for a text file: `text/plain` unless the name says better. */
function _textMime(path) {
    const ext = extname(path).toLowerCase();
    if (ext === ".json")
        return "application/json";
    if (ext === ".svg")
        return "image/svg+xml";
    if (ext === ".html" || ext === ".htm")
        return "text/html";
    if (ext === ".csv" || ext === ".tsv")
        return "text/csv";
    if (ext === ".xml")
        return "application/xml";
    if (ext === ".md" || ext === ".markdown")
        return "text/markdown";
    return "text/plain";
}
/**
 * Mime for bytes we could not classify as image or text — the chunked path's
 * counterpart of `_textMime`. A name that says nothing gets the generic
 * `application/octet-stream`, which the phone only uses as a label.
 */
const BINARY_MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".xz": "application/x-xz",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".epub": "application/epub+zip",
    ".apk": "application/vnd.android.package-archive",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".sqlite": "application/vnd.sqlite3",
    ".db": "application/vnd.sqlite3",
    ".bin": "application/octet-stream",
};
/** Mime for bytes that are neither a supported image nor text. */
export function _binaryMime(path) {
    return BINARY_MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}
/** Mimes whose files are all ZIP containers underneath (the `PK` magic). */
const ZIP_FAMILY_MIMES = new Set([
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.android.package-archive",
    "application/epub+zip",
]);
/**
 * Container magic for formats that START with printable bytes.
 *
 * Why this exists: a PDF's first kilobyte is `%PDF-1.7` plus ASCII, and a text
 * check alone would call it UTF-8 text and hand the phone a "text file" card
 * with raw PDF source in the preview. The bytes still decide — the container
 * signature is part of the bytes, not a guess from the name. The NAME only
 * refines a family (`PK` + `.docx` → the docx mime).
 */
const BINARY_MAGIC = [
    { mime: "application/pdf", matches: (b) => b.length > 4 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
    { mime: "application/zip", matches: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
    { mime: "application/gzip", matches: (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b },
    { mime: "application/x-xz", matches: (b) => b.length > 6 && b.subarray(0, 6).toString("latin1") === "\xfd7zXZ\x00" },
    { mime: "application/x-7z-compressed", matches: (b) => b.length > 6 && b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) },
    { mime: "application/vnd.rar", matches: (b) => b.length > 7 && b.subarray(0, 7).toString("latin1") === "Rar!\x1a\x07\x00" },
    { mime: "application/vnd.sqlite3", matches: (b) => b.length > 16 && b.subarray(0, 16).toString("latin1") === "SQLite format 3\x00" },
    { mime: "application/x-elf", matches: (b) => b.length > 4 && b[0] === 0x7f && b.subarray(1, 4).toString("latin1") === "ELF" },
    { mime: "video/mp4", matches: (b) => b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp" },
    { mime: "application/x-ole-storage", matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
];
/**
 * The mime implied by a binary container signature, or null when the head is
 * not a container we know. A `PK` head is refined by the name (docx/xlsx/apk/
 * epub are all ZIPs); everything else reports its own mime.
 */
export function _sniffBinaryMime(bytes, path) {
    for (const { mime, matches } of BINARY_MAGIC) {
        let hit = false;
        try {
            hit = matches(bytes);
        }
        catch {
            // Truncated buffer inside a matcher: not this container.
        }
        if (!hit)
            continue;
        if (mime !== "application/zip")
            return mime;
        const named = _binaryMime(path);
        return ZIP_FAMILY_MIMES.has(named) ? named : mime;
    }
    return null;
}
/**
 * Whether a large file's bytes look like text. The head is a PREFIX of the
 * file, so a cut inside a multi-byte character must not turn a UTF-8 document
 * into "binary": the last few bytes are dropped before the strict decode, and
 * only a decode that still fails is a real verdict.
 */
export function _looksLikeText(head) {
    if (_decodeTextStrict(head) !== null)
        return true;
    for (let trim = 1; trim <= 3 && head.length > trim; trim++) {
        if (_decodeTextStrict(head.subarray(0, head.length - trim)) !== null)
            return true;
    }
    return false;
}
// ── encoding ─────────────────────────────────────────────────────────────────
function _fail(code, message) {
    return { ok: false, code, message };
}
/**
 * Read `path` and return what should go on the wire: the metadata plus the
 * base64 payload. Never throws — a missing file, a directory, a binary blob or
 * something that will not fit under the cap all come back as a typed failure
 * the tool turns into a message the model can act on.
 */
export async function _encodeAttachment(rawPath) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return _fail("not_found", "No path given.");
    }
    let path;
    try {
        // realpath first: the wire reports the resolved path, so a symlink or a
        // `~` the shell expanded can never point somewhere the app didn't name.
        path = realpathSync(rawPath.trim());
    }
    catch {
        return _fail("not_found", `No such file: ${rawPath}`);
    }
    let size;
    try {
        const st = statSync(path);
        if (!st.isFile())
            return _fail("not_found", `Not a regular file: ${path}`);
        size = st.size;
    }
    catch (err) {
        return _fail("not_found", `Cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (size === 0)
        return _fail("unsupported", `${basename(path)} is empty.`);
    // Read a bounded prefix for sniffing: a 400 MB video must not be pulled into
    // memory just to learn that we will refuse it anyway. `+ 1` so a file that
    // grew between `stat` and `read` is detected as over-cap rather than
    // silently truncated into a "valid" image.
    const cap = Math.min(size, ATTACHMENT_MAX_BYTES) + 1;
    let head;
    try {
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(cap);
            const read = readSync(fd, buf, 0, cap, 0);
            head = buf.subarray(0, read);
        }
        finally {
            closeSync(fd);
        }
    }
    catch (err) {
        return _fail("internal_error", `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const imageMime = _sniffImageMime(head);
    if (imageMime) {
        if (size <= ATTACHMENT_MAX_BYTES) {
            // Small enough: ship the original bytes untouched (no re-encode, no loss).
            return {
                ok: true,
                data: head.toString("base64"),
                meta: { id: "", name: basename(path), path, mime: imageMime, size },
            };
        }
        const resized = await resizeImage(head, imageMime, {
            maxWidth: ATTACHMENT_MAX_DIM,
            maxHeight: ATTACHMENT_MAX_DIM,
            maxBytes: ATTACHMENT_MAX_BYTES,
        }).catch(() => null);
        if (!resized) {
            return _fail("too_large", `${basename(path)} is ${size} bytes and could not be downscaled under the ` +
                `${ATTACHMENT_MAX_BYTES} byte limit. Share a link or a smaller export instead.`);
        }
        return {
            ok: true,
            data: resized.data,
            meta: {
                id: "",
                name: basename(path),
                path,
                mime: resized.mimeType,
                size: Math.floor((resized.data.length * 3) / 4),
                resized: true,
                original_size: size,
            },
        };
    }
    if (size > ATTACHMENT_TEXT_MAX_BYTES) {
        return _fail("unsupported", `${basename(path)} is ${size} bytes and is not an image. The phone channel carries images ` +
            `and text files up to ${ATTACHMENT_TEXT_MAX_BYTES} bytes in one frame; larger files ` +
            `are streamed instead.`);
    }
    // A container that happens to start with printable bytes (a PDF, a ZIP) is
    // not text: it would reach the phone as a "text file" card full of source.
    if (_sniffBinaryMime(head, path) !== null || _decodeTextStrict(head) === null) {
        return _fail("unsupported", `${basename(path)} is binary. The single-frame channel carries images and text files only.`);
    }
    return {
        ok: true,
        data: head.toString("base64"),
        meta: { id: "", name: basename(path), path, mime: _textMime(path), size },
    };
}
const EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
};
/** File extension for a mime we report, for the card's name. */
export function _imageExtForMime(mime) {
    return EXT_BY_MIME[mime] ?? "img";
}
/**
 * Every image block a tool result carries, in order.
 *
 * Live, `tool_execution_end` hands us the wrapper `{ content, details }`; the
 * history path sees a bare content-array. Both shapes are accepted (same rule
 * as `_stringifyToolResult`), and a block without bytes is skipped rather than
 * turned into an empty card.
 */
export function _imageBlocksFromToolResult(value) {
    const content = Array.isArray(value)
        ? value
        : value && typeof value === "object" && Array.isArray(value.content)
            ? value.content
            : [];
    const blocks = [];
    for (const raw of content) {
        if (!raw || typeof raw !== "object")
            continue;
        const block = raw;
        if (block.type !== "image")
            continue;
        if (typeof block.data !== "string" || !block.data)
            continue;
        blocks.push({
            data: block.data,
            mimeType: typeof block.mimeType === "string" ? block.mimeType : "",
        });
    }
    return blocks;
}
let _inlineImageDirOverride;
/** Test seam: materialise tool images in a temp dir, not `~/.pi/remote`. */
export function _setInlineImageDirForTest(dir) {
    _inlineImageDirOverride = dir;
}
/** `<home>/.pi/remote/attachments` — sibling of `uploads/` and `config.json`. */
function _inlineImageDir() {
    const dir = _inlineImageDirOverride ?? join(homedir(), ".pi", "remote", "attachments");
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch { /* exists */ }
    return dir;
}
/** Cards kept in the store. Each one is what a `file_get` reads later, so they
 *  cannot be dropped on the spot — but a session that screenshots all day must
 *  not leave the daemon growing a file per screenshot forever. Past this point
 *  the oldest cards lose their bytes (the app has long since cached the ones
 *  somebody actually looked at, and an ancient card shows the app's
 *  "gone" state instead of a broken image). */
export const INLINE_IMAGE_KEEP = 300;
/** Delete all but the `keep` newest files of the inline-image store. */
export function _pruneInlineImageStore(dir, keep) {
    let names;
    try {
        names = readdirSync(dir).filter((name) => !name.startsWith("."));
    }
    catch {
        return;
    }
    if (names.length <= keep)
        return;
    const stamped = [];
    for (const name of names) {
        const path = join(dir, name);
        try {
            const st = statSync(path);
            if (st.isFile())
                stamped.push({ path, mtime: st.mtimeMs });
        }
        catch { /* vanished under us — nothing to prune */ }
    }
    stamped.sort((a, b) => b.mtime - a.mtime);
    for (const { path } of stamped.slice(Math.max(0, keep))) {
        try {
            unlinkSync(path);
        }
        catch { /* best-effort */ }
    }
}
/** A card id doubles as the file name, so it has to be one safe path segment. */
function _safeCardId(raw) {
    const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    return cleaned || `att_${Date.now().toString(36)}`;
}
/** The card's display name, with the extension the BYTES call for: kept when
 *  it already matches, replaced when the downscale changed the format
 *  (`huge.png` → `huge.jpg`), appended when the name had none. */
function _nameWithExt(rawName, ext) {
    const name = basename(rawName.trim()).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) || "image";
    const dot = name.lastIndexOf(".");
    if (dot <= 0)
        return `${name}.${ext}`;
    const current = name.slice(dot + 1).toLowerCase();
    if (current === ext)
        return name;
    return Object.values(EXT_BY_MIME).includes(current) ? `${name.slice(0, dot)}.${ext}` : `${name}.${ext}`;
}
/**
 * Encode one inline image block: write it under `~/.pi/remote/attachments` and
 * return what the wire needs. Both the live offer and the later `file_get` read
 * the file we wrote here, so the card keeps showing the picture it was born
 * with. Downscaling reuses the `send_to_phone` path — same cap, same reason
 * (see the module comment) — but the result is written to disk as well, since
 * the downscaled bytes exist nowhere else.
 */
export async function _encodeInlineImage(block, opts) {
    const bytes = Buffer.from(block.data, "base64");
    if (bytes.length === 0)
        return _fail("unsupported", "The image block carried no bytes.");
    // Content first, like every other path here: a block that says `image/png`
    // but holds something else does not get a card.
    const mime = _sniffImageMime(bytes);
    if (!mime)
        return _fail("unsupported", `The image block is not a supported image (${block.mimeType || "unknown type"}).`);
    const id = _safeCardId(opts.id);
    const dir = _inlineImageDir();
    const original = bytes.length;
    const name = _nameWithExt(opts.name ?? id, _imageExtForMime(mime));
    try {
        if (original <= ATTACHMENT_MAX_BYTES) {
            const path = join(dir, `${id}.${_imageExtForMime(mime)}`);
            writeFileSync(path, bytes, { mode: 0o600 });
            _pruneInlineImageStore(dir, INLINE_IMAGE_KEEP);
            return { ok: true, data: bytes.toString("base64"), meta: { id, name, path, mime, size: original } };
        }
        const resized = await resizeImage(bytes, mime, {
            maxWidth: ATTACHMENT_MAX_DIM,
            maxHeight: ATTACHMENT_MAX_DIM,
            maxBytes: ATTACHMENT_MAX_BYTES,
        }).catch(() => null);
        if (!resized) {
            return _fail("too_large", `An inline image of ${original} bytes could not be downscaled under the ` +
                `${ATTACHMENT_MAX_BYTES} byte limit.`);
        }
        const out = Buffer.from(resized.data, "base64");
        const path = join(dir, `${id}.${_imageExtForMime(resized.mimeType)}`);
        writeFileSync(path, out, { mode: 0o600 });
        _pruneInlineImageStore(dir, INLINE_IMAGE_KEEP);
        return {
            ok: true,
            data: resized.data,
            meta: {
                id,
                name: _nameWithExt(opts.name ?? id, _imageExtForMime(resized.mimeType)),
                path,
                mime: resized.mimeType,
                size: out.length,
                resized: true,
                original_size: original,
            },
        };
    }
    catch (err) {
        return _fail("internal_error", `Cannot store the inline image: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function _humanSize(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} bytes`;
}
function _sentLine(meta) {
    const parts = [`Sent ${meta.name} (${meta.mime}, ${_humanSize(meta.size)})`];
    if (meta.resized && meta.original_size)
        parts.push(`downscaled from ${_humanSize(meta.original_size)}`);
    return `${parts.join(", ")} to the phone.`;
}
/** Read up to `cap` bytes from the start of `path`. */
function _readHead(path, cap) {
    try {
        const fd = openSync(path, "r");
        try {
            const buffer = Buffer.alloc(cap);
            const read = readSync(fd, buffer, 0, cap, 0);
            return buffer.subarray(0, read);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
/**
 * Classify a file for the chunked path: resolve the real path, enforce the
 * ceiling, and decide the mime from the BYTES (image magic → that image type;
 * otherwise strict-text → the name's text type; otherwise the name's binary
 * type). Never throws.
 */
export function _probeChunkedAttachment(rawPath) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { ok: false, message: "No path given." };
    }
    let path;
    try {
        path = realpathSync(rawPath.trim());
    }
    catch {
        return { ok: false, message: `No such file: ${rawPath}` };
    }
    let size;
    try {
        const st = statSync(path);
        if (!st.isFile())
            return { ok: false, message: `Not a regular file: ${path}` };
        size = st.size;
    }
    catch (err) {
        return { ok: false, message: `Cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (size === 0)
        return { ok: false, message: `${basename(path)} is empty.` };
    if (size > FILE_SEND_MAX_BYTES) {
        return {
            ok: false,
            message: `${basename(path)} is ${_humanSize(size)}; the phone channel carries at most ` +
                `${Math.floor(FILE_SEND_MAX_BYTES / (1024 * 1024))} MiB. Share a link instead.`,
        };
    }
    const head = _readHead(path, Math.min(size, ATTACHMENT_TEXT_MAX_BYTES + 4));
    if (head === null)
        return { ok: false, message: `Cannot read ${path}.` };
    const imageMime = _sniffImageMime(head);
    const mime = imageMime ?? _sniffBinaryMime(head, path) ??
        (_looksLikeText(head) ? _textMime(path) : _binaryMime(path));
    return { ok: true, path, name: basename(path), mime, size };
}
/**
 * Hand one file to the phone, picking the cheapest route that works: a single
 * `file_offer` when the bytes fit one envelope (images are downscaled into it),
 * otherwise the chunked stream. Both routes remember the same metadata, so the
 * card replays identically either way.
 */
export async function _deliverToPhone(rawPath, note, id, deps) {
    const caption = typeof note === "string" && note.trim() ? note.trim() : undefined;
    const inline = await _encodeAttachment(rawPath);
    if (inline.ok) {
        const meta = {
            ...inline.meta,
            id,
            ...(caption ? { note: caption } : {}),
        };
        deps.broadcast({ type: "file_offer", ...meta, data: inline.data });
        deps.remember(meta);
        return { ok: true, meta, message: _sentLine(meta) };
    }
    // `not_found`/`internal_error` are final. `too_large`/`unsupported` mean the
    // file needs the streaming path — either it exceeds one envelope or it is not
    // an image/text at all.
    if (inline.code === "not_found" || inline.code === "internal_error") {
        return { ok: false, message: inline.message };
    }
    if (!deps.sendChunked) {
        return {
            ok: false,
            message: `${inline.message} This build cannot stream files yet, so only images and ` +
                `text files up to ${Math.floor(ATTACHMENT_TEXT_MAX_BYTES / 1024)} KB can be sent.`,
        };
    }
    const probe = _probeChunkedAttachment(rawPath);
    if (!probe.ok)
        return { ok: false, message: probe.message };
    const streamed = await deps.sendChunked({
        id,
        path: probe.path,
        name: probe.name,
        mime: probe.mime,
        size: probe.size,
        ...(caption ? { note: caption } : {}),
    });
    if (!streamed.ok)
        return { ok: false, message: streamed.message };
    const meta = {
        id,
        name: probe.name,
        path: probe.path,
        mime: probe.mime,
        size: probe.size,
        ...(caption ? { note: caption } : {}),
    };
    deps.remember(meta);
    return {
        ok: true,
        meta,
        message: `${_sentLine(meta)} Streamed in ${streamed.chunks} chunks.`,
    };
}
/**
 * Register `send_to_phone`. Registered tools are active by default (same rule
 * as `agent_send`), so the model can hand a file over without any setup.
 *
 * The tool deliberately publishes NO `tool_request`/`tool_result` to the app:
 * the attachment card IS the app's rendering of this call, and a second card
 * for the same event would just be noise. The model still gets a one-line
 * result (and the details object), so it can report honestly what happened.
 */
export function registerSendToPhoneTool(pi, deps) {
    const Params = Type.Object({
        path: Type.String({
            description: "Absolute path of the file on this machine (image or text file).",
        }),
        note: Type.Optional(Type.String({
            description: "One short line shown under the card on the phone, in the user's language.",
        })),
    });
    pi.registerTool({
        name: SEND_TO_PHONE_TOOL,
        label: "Send To Phone",
        description: "Show a file from this machine in the phone app: it appears as a card in the chat " +
            "timeline. Images render inline and text files show a name plus a preview; anything " +
            "else (PDF, archive, video, any binary) is streamed in chunks and the card offers " +
            "saving it to the phone. Use it to hand over a screenshot, a chart, a generated " +
            "report or any other file the user asked to see. One file per call, up to 250 MB.",
        promptSnippet: "send_to_phone({path, note?}): puts a file from this machine into the chat on the phone " +
            "(image → inline thumbnail, text → preview, any other file streamed and savable; ≤250 MB).",
        parameters: Params,
        execute: async (toolCallId, params) => {
            const { path, note } = params;
            const result = await _deliverToPhone(path, note, `att_${toolCallId}`, deps);
            if (!result.ok || !result.meta) {
                // `ok: false` is what the model reads; details mirror it for the TUI.
                return {
                    content: [{ type: "text", text: `Could not send the file: ${result.message}` }],
                    details: { ok: false, error: result.message, id: "", name: "", path: "", mime: "", size: 0 },
                };
            }
            return { content: [{ type: "text", text: result.message }], details: { ...result.meta, ok: true } };
        },
    });
}
/** Card ids are `att_<toolCallId>`; anything else from the wire is replaced. */
const ATTACHMENT_ID_RE = /^att_[A-Za-z0-9_-]{1,64}$/;
/**
 * Answer a `file_get` with the bytes for one card.
 *
 * The app asks by `path` and names the card it wants filled
 * (`attachment_id`, the id the `attachment` history event carried), so the
 * reply upserts the existing bubble instead of adding a second one. A missing
 * or malformed id is not fatal: we mint one from the request id, and the app
 * still gets the content to show.
 *
 * Small files answer with one `file_offer`; a file that does not fit (or is
 * binary) is streamed instead, with the same card id, when `deps.sendChunked`
 * is wired — the app's receive path is identical for both.
 */
export async function handleFileGetRequest(msg, reply, deps) {
    const requested = typeof msg.attachment_id === "string" ? msg.attachment_id : "";
    const cardId = ATTACHMENT_ID_RE.test(requested) ? requested : `att_get_${msg.id}`;
    const encoded = await _encodeAttachment(msg.path);
    if (encoded.ok) {
        reply({
            type: "file_offer",
            ...encoded.meta,
            id: cardId,
            data: encoded.data,
            in_reply_to: msg.id,
        });
        return;
    }
    if (encoded.code === "not_found" || encoded.code === "internal_error" || !deps?.sendChunked) {
        reply({ type: "error", in_reply_to: msg.id, code: encoded.code, message: encoded.message });
        return;
    }
    const probe = _probeChunkedAttachment(msg.path);
    if (!probe.ok) {
        reply({ type: "error", in_reply_to: msg.id, code: "unsupported", message: probe.message });
        return;
    }
    const streamed = await deps.sendChunked({
        id: cardId,
        path: probe.path,
        name: probe.name,
        mime: probe.mime,
        size: probe.size,
    });
    if (!streamed.ok) {
        reply({
            type: "error",
            in_reply_to: msg.id,
            code: streamed.code === "too_large" ? "too_large" : "internal_error",
            message: streamed.message,
        });
    }
}
//# sourceMappingURL=attachment.js.map