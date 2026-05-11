// src/hitl/sheets-link.ts
//
// Generates Google Sheets deeplinks for HITL approval rows. The link points
// directly to the row containing the approval, with the relevant cell pre-
// selected. Uses the spreadsheet ID + sheet name from the tenant config plus
// the row number stored on the approval.
//
// Format:
//   https://docs.google.com/spreadsheets/d/<id>/edit#gid=<sheet_gid>&range=A<row>:Z<row>
//
// Note: gid is the sheet-tab id (an integer). If the tenant config only has
// the sheet NAME, we fall back to a link that opens the spreadsheet without
// jumping to the row — still useful, just less precise.

export interface SheetsLinkInput {
  spreadsheetId: string
  sheetGid?:     number     // the gid of the tab; if unknown, fall back to no anchor
  sheetName?:    string     // human-readable, used in the URL path style as fallback
  rowNumber?:    number     // 1-based row number on the sheet
}

export function buildSheetsLink(input: SheetsLinkInput): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.spreadsheetId)}/edit`

  if (input.sheetGid != null && input.rowNumber != null) {
    return `${base}#gid=${input.sheetGid}&range=A${input.rowNumber}:Z${input.rowNumber}`
  }

  if (input.sheetName && input.rowNumber != null) {
    // Range syntax with sheet name needs URL encoding of single quotes
    const range = `'${input.sheetName}'!A${input.rowNumber}:Z${input.rowNumber}`
    return `${base}?range=${encodeURIComponent(range)}`
  }

  return base
}
