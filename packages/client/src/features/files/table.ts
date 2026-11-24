// CSV and TSV as a table (spec/FILES-AND-ENVIRONMENT.md §8.2): RFC 4180 quoting (a quoted field
// holds the delimiter, newlines and doubled quotes), any line ending. The view shows the header
// and the first rows; the text itself is one choice away.

/** Rows the table shows after the header; Edit as text shows them all. */
export const TABLE_ROWS_SHOWN = 1000

export interface Table {
  /** The header first, then at most `TABLE_ROWS_SHOWN` rows, each padded to the widest row shown. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
  /** Rows after the header, all of them. */
  readonly total: number
}

export const parseTable = (text: string, delimiter: "," | "\t", limit = TABLE_ROWS_SHOWN): Table => {
  const rows: Array<Array<string>> = []
  let total = 0
  let row: Array<string> = []
  let field = ""
  let fieldStarted = false
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(field)
    field = ""
    fieldStarted = false
    if (rows.length <= limit) rows.push(row)
    total++
    row = []
  }
  while (i < text.length) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else field += c
      i++
      continue
    }
    if (c === delimiter) {
      row.push(field)
      field = ""
      fieldStarted = false
    } else if (c === "\r" || c === "\n") {
      endRow()
      if (c === "\r" && text[i + 1] === "\n") i++
    } else {
      fieldStarted = true
      if (c === '"' && field === "") quoted = true
      else field += c
    }
    i++
  }
  if (fieldStarted || row.length > 0) endRow()
  const width = Math.max(0, ...rows.map((r) => r.length))
  return {
    rows: rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r)),
    total: Math.max(0, total - 1)
  }
}
