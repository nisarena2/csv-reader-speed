// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for the case input {text, header}.
//
// The reference reads one character at a time and builds every field up a
// character at a time. This reader does the same reading, but in slices: it
// finds the next comma, line break or quote with indexOf and takes whole
// fields with slice, so the common record costs a handful of short scans
// instead of one step per character. Every broken-row rule is the
// reference's own, in the same order:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside it
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met, a record's
//     short_row or long_row when it ends: line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and row
//     its record's index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Each case is answered alone.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Set at the record's start, before its fields
  // are read, so an error met while reading it carries them.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field from pos, starting from `init` and counting the
  // characters kept in `added`. Stray CRs are dropped (stray_cr) and the
  // field is taken as one slice per stretch between them. Returns the field
  // and how it ended; pos and line are advanced past the terminator.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    const p = pos;
    const kC = text.indexOf(',', p);
    const kN = text.indexOf('\n', p);
    if (kC !== -1 && (kN === -1 || kC < kN)) {
      // The field ends at the comma: every CR in [p, kC) is stray, since
      // the first LF at or after p lies past the comma (or there is none).
      let seg = text.slice(p, kC);
      let s = 0;
      let idx = seg.indexOf('\r');
      while (idx !== -1) {
        error('stray_cr');
        value += seg.slice(s, idx);
        added += idx - s;
        s = idx + 1;
        idx = seg.indexOf('\r', s);
      }
      value += seg.slice(s);
      added += seg.length - s;
      pos = kC + 1;
      return { value, ended: COMMA, added };
    }
    if (kN !== -1) {
      // The field ends at the line break: a CR just before the LF is the
      // CRLF, every other CR in the stretch is stray.
      let seg = text.slice(p, kN);
      if (seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
      let s = 0;
      let idx = seg.indexOf('\r');
      while (idx !== -1) {
        error('stray_cr');
        value += seg.slice(s, idx);
        added += idx - s;
        s = idx + 1;
        idx = seg.indexOf('\r', s);
      }
      value += seg.slice(s);
      added += seg.length - s;
      pos = kN + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
    // The field ends at the end of the text: every CR in it is stray.
    let seg = text.slice(p);
    let s = 0;
    let idx = seg.indexOf('\r');
    while (idx !== -1) {
      error('stray_cr');
      value += seg.slice(s, idx);
      added += idx - s;
      s = idx + 1;
      idx = seg.indexOf('\r', s);
    }
    value += seg.slice(s);
    added += seg.length - s;
    pos = n;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // and how it ended, and the line breaks its quotes held, in quotedLines;
  // pos and line are advanced past the terminator.
  let quotedLines = 0;
  function readQuoted() {
    const open = pos;
    let value = '';
    let newlines = 0; // LF, CRLF and lone CR inside the quotes, counted here
    let segStart = open + 1;
    let p = open + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. The newlines counted above
        // are dropped with it: line still stands at the opening quote.
        pos = open + 1;
        error('unterminated_quote');
        quotedLines = 0;
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: the stretch before it, then one quote.
        appendQuoted(segStart, q);
        value += '"';
        p = q + 2;
        segStart = q + 2;
        continue;
      }
      // The closing quote.
      appendQuoted(segStart, q);
      line += newlines;
      quotedLines = newlines;
      const j = q + 1;
      if (j >= n) {
        pos = n;
        return { value, ended: END };
      }
      const c = text.charCodeAt(j);
      if (c === 44) {
        pos = j + 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos = j + 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(j + 1) === 10) {
        pos = j + 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      pos = j;
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }

    // Appends the quoted stretch text[a, b) to value, reading each CRLF or
    // lone CR in it as one LF, and counts its line breaks in newlines.
    function appendQuoted(a, b) {
      const seg = text.slice(a, b);
      if (seg.indexOf('\r') === -1) {
        value += seg;
        let k = -1;
        while ((k = seg.indexOf('\n', k + 1)) !== -1) newlines++;
        return;
      }
      const t = seg.replace(/\r\n?/g, '\n');
      value += t;
      let k = -1;
      while ((k = t.indexOf('\n', k + 1)) !== -1) newlines++;
    }
  }

  // Finishes a record read into `fields` (whose last field was quoted when
  // `quoted` holds): a line left with no characters is no record, else the
  // header, or a row padded or cut to the first record's width.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A whole clean line: no quote starts a quoted field on it, and no CR
    // but the line break's own. Its fields are one split, no field at a
    // time. Anything else falls through to the field loop below. lineEnd is
    // the next LF at or after pos (n when there is none): the field loop
    // reuses it for its unquoted fields, since no line break is crossed
    // while a field ends at a comma.
    const nl = text.indexOf('\n', pos);
    let lineEnd = nl === -1 ? n : nl;
    const lineStr = text.slice(pos, lineEnd);
    if (lineStr.indexOf('"') === -1) {
      let clean = lineStr;
      if (nl !== -1 && clean.charCodeAt(clean.length - 1) === 13) {
        clean = clean.slice(0, -1);
        if (clean.indexOf('\r') === -1) {
          finishRecord(clean.split(','), false);
          pos = nl + 1;
          line += 1;
          continue;
        }
      } else if (clean.indexOf('\r') === -1) {
        finishRecord(clean.split(','), false);
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    let fvalue = '';
    let fended = COMMA;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const qf = readQuoted();
        fvalue = qf.value;
        fended = qf.ended;
        // A quoted field that held a line break crossed lineEnd: the next
        // unquoted field finds its own line end. One that held none, and
        // one that never closed, left it standing.
        if (fended === COMMA && quotedLines > 0) lineEnd = -1;
      } else {
        quoted = false;
        // An unquoted field: the stretch to the next comma or to lineEnd,
        // taken as one slice when it holds no stray CR.
        if (lineEnd === -1) {
          lineEnd = text.indexOf('\n', pos);
          if (lineEnd === -1) lineEnd = n;
        }
        const kC = text.indexOf(',', pos);
        if (kC !== -1 && kC < lineEnd) {
          const seg = text.slice(pos, kC);
          if (seg.indexOf('\r') === -1) {
            fvalue = seg;
            fended = COMMA;
            pos = kC + 1;
          } else {
            const r = readUnquoted('');
            fvalue = r.value;
            fended = r.ended;
          }
        } else if (lineEnd < n) {
          let seg = text.slice(pos, lineEnd);
          if (seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
          if (seg.indexOf('\r') === -1) {
            fvalue = seg;
            fended = LINE_BREAK;
            pos = lineEnd + 1;
            line += 1;
          } else {
            const r = readUnquoted('');
            fvalue = r.value;
            fended = r.ended;
          }
        } else {
          const seg = text.slice(pos);
          if (seg.indexOf('\r') === -1) {
            fvalue = seg;
            fended = END;
            pos = n;
          } else {
            const r = readUnquoted('');
            fvalue = r.value;
            fended = r.ended;
          }
        }
      }
      fields.push(fvalue);
    } while (fended === COMMA);

    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
