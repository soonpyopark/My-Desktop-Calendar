import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { EXPORT_COLORS } from '../../shared/exportColors.js';
import { prepareMonthExportLayout } from '../../shared/monthExportLayout.js';
import { isNativeHost, nativeRequest } from './nativeHost.js';

const FONT_NAME = 'Malgun Gothic';
const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFE8EAED' } },
  left: { style: 'thin', color: { argb: 'FFE8EAED' } },
  bottom: { style: 'thin', color: { argb: 'FFE8EAED' } },
  right: { style: 'thin', color: { argb: 'FFE8EAED' } },
};

function hexToArgb(hex) {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

function getExportFileName({ scope, year, month }, extension) {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  if (scope === 'year') return `calendar_${year}_${stamp}.${extension}`;
  return `calendar_${year}${String(month).padStart(2, '0')}_${stamp}.${extension}`;
}

/** @type {ArrayBuffer | null} */
let cachedKoreanFont = null;

/**
 * Load a Korean TTF for PDFKit (system font via native host, or bundled fallback).
 * @returns {Promise<ArrayBuffer>}
 */
async function loadKoreanFontBuffer() {
  if (cachedKoreanFont) {
    return cachedKoreanFont;
  }

  const candidates = [
    'https://winfonts.local/malgun.ttf',
    'https://winfonts.local/malgunbd.ttf',
    'https://winfonts.local/malgunsl.ttf',
    './fonts/NotoSansKR-Regular.otf',
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 1000) {
        cachedKoreanFont = buffer;
        return cachedKoreanFont;
      }
    } catch {
      /* try next */
    }
  }

  if (isNativeHost()) {
    try {
      const result = await nativeRequest('GET', '/api/desktop/fonts/korean');
      if (result?.base64) {
        const binary = atob(result.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        cachedKoreanFont = bytes.buffer;
        return cachedKoreanFont;
      }
    } catch {
      /* fall through */
    }
  }

  throw new Error('PDF 생성을 위한 한글 폰트를 찾을 수 없습니다.');
}

function uint8FromBufferLike(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer);
  }
  return new Uint8Array(value);
}

function getWeekdayHeaderColor(dayIndex, weekStartsOn) {
  const dayOfWeek = (weekStartsOn + dayIndex) % 7;
  if (dayOfWeek === 0) return EXPORT_COLORS.sunday;
  if (dayOfWeek === 6) return EXPORT_COLORS.saturday;
  return EXPORT_COLORS.heading;
}

function buildDateRichText(day) {
  const parts = [
    {
      text: String(day.solar),
      font: {
        name: FONT_NAME,
        size: 12,
        bold: day.isToday,
        color: { argb: hexToArgb(day.solarColor) },
      },
    },
  ];

  if (day.lunarLabel) {
    parts.push({
      text: ` (${day.lunarLabel})`,
      font: {
        name: FONT_NAME,
        size: 9,
        color: { argb: hexToArgb(day.inMonth ? EXPORT_COLORS.muted : EXPORT_COLORS.otherMonth) },
      },
    });
  }

  return parts;
}

const EXPORT_DATE_HEADER = 24;
const EXPORT_EVENT_LINE = 12;
const PDF_EVENT_FONT_SIZE = 8;
const PDF_EVENT_GAP = 2;
const PDF_STRIPE_WIDTH = 3;
const PDF_TEXT_GAP = 5;
const PDF_CELL_PADDING = 4;
const PDF_MIN_EVENT_BAR_HEIGHT = 10;

function getExportWeekRowHeight(week, minRowHeight) {
  const maxEvents = Math.max(0, ...week.days.map((day) => day.events.length));
  return Math.max(minRowHeight, EXPORT_DATE_HEADER + maxEvents * EXPORT_EVENT_LINE + 6);
}

/**
 * @param {number} dayColumnWidth
 */
function getPdfEventTextWidth(dayColumnWidth) {
  return dayColumnWidth - PDF_CELL_PADDING - PDF_STRIPE_WIDTH - PDF_TEXT_GAP - PDF_CELL_PADDING;
}

/**
 * @param {import('pdfkit').default} doc
 * @param {string} line
 * @param {number} textWidth
 */
function measurePdfEventTextHeight(doc, line, textWidth) {
  doc.fontSize(PDF_EVENT_FONT_SIZE);
  return doc.heightOfString(line, { width: Math.max(1, textWidth) });
}

/**
 * @param {import('pdfkit').default} doc
 * @param {object} day
 * @param {number} textWidth
 */
function measurePdfDayEventsHeight(doc, day, textWidth) {
  let height = 0;
  for (const event of day.events) {
    const textHeight = measurePdfEventTextHeight(doc, event.line, textWidth);
    height += Math.max(PDF_MIN_EVENT_BAR_HEIGHT, textHeight) + PDF_EVENT_GAP;
  }
  return height;
}

/**
 * @param {import('pdfkit').default} doc
 * @param {object} week
 * @param {number} dayColumnWidth
 * @param {number} minRowHeight
 */
function getPdfWeekRowHeight(doc, week, dayColumnWidth, minRowHeight) {
  const textWidth = getPdfEventTextWidth(dayColumnWidth);
  const maxEventsHeight = Math.max(
    0,
    ...week.days.map((day) => measurePdfDayEventsHeight(doc, day, textWidth)),
  );
  return Math.max(minRowHeight, EXPORT_DATE_HEADER + maxEventsHeight + 6);
}

function buildDayCellEventRichText(day) {
  /** @type {import('exceljs').RichText[]} */
  const parts = [];

  day.events.forEach((event) => {
    parts.push({
      text: '\n',
      font: { name: FONT_NAME, size: 9 },
    });
    parts.push({
      text: '▎ ',
      font: {
        name: FONT_NAME,
        size: 9,
        color: { argb: hexToArgb(event.color) },
      },
    });
    parts.push({
      text: event.line,
      font: {
        name: FONT_NAME,
        size: 9,
        color: { argb: hexToArgb(EXPORT_COLORS.body) },
      },
    });
  });

  return parts;
}

function getHeaderBgFill() {
  return {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: hexToArgb(EXPORT_COLORS.weekdayHeaderBg) },
  };
}

function getGridColumnCount(layout) {
  return layout.showWeekNumbers ? 8 : 7;
}

function styleWorksheetPage(worksheet, columnCount) {
  worksheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
  };
  worksheet.pageSetup.printArea = `A1:${String.fromCharCode(64 + columnCount)}20`;
}

/**
 * @param {ReturnType<typeof prepareMonthExportLayout>} layout
 */
async function buildExcelCalendarBuffer(layout) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(`${layout.month}월`, {
    views: [{ showGridLines: false }],
  });
  const columnCount = getGridColumnCount(layout);
  const lastColumnLetter = String.fromCharCode(64 + columnCount);

  styleWorksheetPage(worksheet, columnCount);

  const titleStartCol = layout.showWeekNumbers ? 2 : 1;
  const titleEndCol = columnCount - 1;
  const titleStartLetter = String.fromCharCode(64 + titleStartCol);
  const titleEndLetter = String.fromCharCode(64 + titleEndCol);
  const lunarLetter = lastColumnLetter;

  if (layout.showWeekNumbers) {
    const weekTitleCell = worksheet.getCell('A1');
    weekTitleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: hexToArgb(EXPORT_COLORS.weekColumnBg) },
    };
  }

  worksheet.mergeCells(`${titleStartLetter}1:${titleEndLetter}1`);
  const titleCell = worksheet.getCell(`${titleStartLetter}1`);
  titleCell.value = layout.title;
  titleCell.font = { name: FONT_NAME, bold: true, size: 18, color: { argb: hexToArgb(EXPORT_COLORS.heading) } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

  const lunarCell = worksheet.getCell(`${lunarLetter}1`);
  lunarCell.value = layout.lunarMonthLabel;
  lunarCell.font = { name: FONT_NAME, size: 11, color: { argb: hexToArgb(EXPORT_COLORS.lunarBlue) } };
  lunarCell.alignment = { vertical: 'middle', horizontal: 'right' };
  worksheet.getRow(1).height = 34;

  const headerRowIndex = 2;
  const headerRow = worksheet.getRow(headerRowIndex);
  headerRow.height = 22;

  let columnIndex = 1;
  if (layout.showWeekNumbers) {
    const weekHeaderCell = headerRow.getCell(columnIndex);
    weekHeaderCell.value = '';
    weekHeaderCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: hexToArgb(EXPORT_COLORS.weekColumnBg) },
    };
    weekHeaderCell.border = THIN_BORDER;
    worksheet.getColumn(columnIndex).width = 5;
    columnIndex += 1;
  }

  layout.weekdayHeaders.forEach((label, index) => {
    const cell = headerRow.getCell(columnIndex);
    cell.value = label;
    cell.font = {
      name: FONT_NAME,
      bold: true,
      size: 10,
      color: { argb: hexToArgb(getWeekdayHeaderColor(index, layout.weekStartsOn)) },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = THIN_BORDER;
    cell.fill = getHeaderBgFill();
    worksheet.getColumn(columnIndex).width = 18;
    columnIndex += 1;
  });

  layout.weekRows.forEach((week, weekIndex) => {
    const rowIndex = headerRowIndex + 1 + weekIndex;
    const row = worksheet.getRow(rowIndex);
    row.height = getExportWeekRowHeight(week, 92);
    let col = 1;

    if (layout.showWeekNumbers) {
      const weekCell = row.getCell(col);
      weekCell.value = week.weekNumber;
      weekCell.font = { name: FONT_NAME, size: 10, color: { argb: hexToArgb(EXPORT_COLORS.muted) } };
      weekCell.alignment = { vertical: 'top', horizontal: 'center' };
      weekCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: hexToArgb(EXPORT_COLORS.weekColumnBg) },
      };
      weekCell.border = THIN_BORDER;
      col += 1;
    }

    week.days.forEach((day) => {
      const cell = row.getCell(col);
      const richText = [...buildDateRichText(day), ...buildDayCellEventRichText(day)];

      cell.value = richText.length > 0 ? { richText } : '';
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
      cell.border = THIN_BORDER;

      if (day.isToday) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: hexToArgb(EXPORT_COLORS.todayBg) },
        };
      }

      col += 1;
    });
  });

  return uint8FromBufferLike(await workbook.xlsx.writeBuffer());
}

function drawPdfTitle(doc, layout, contentWidth, margin) {
  const titleY = margin + 4;
  doc.fillColor(EXPORT_COLORS.heading)
    .fontSize(20)
    .text(layout.title, margin, titleY, { width: contentWidth, align: 'center' });

  doc.fillColor(EXPORT_COLORS.lunarBlue)
    .fontSize(11)
    .text(layout.lunarMonthLabel, margin, titleY + 6, { width: contentWidth, align: 'right' });
}

/**
 * @param {import('pdfkit').default} doc
 * @param {ReturnType<typeof prepareMonthExportLayout>} layout
 * @param {number} margin
 * @param {number} contentWidth
 * @param {number} weekColumnWidth
 * @param {number} dayColumnWidth
 * @param {number} titleHeight
 * @param {number} weekdayRowHeight
 * @returns {{ gridX: number, bodyStartY: number }}
 */
function drawPdfPageHeader(doc, layout, margin, contentWidth, weekColumnWidth, dayColumnWidth, titleHeight, weekdayRowHeight) {
  drawPdfTitle(doc, layout, contentWidth, margin);

  const gridTop = margin + titleHeight;
  let gridX = margin;

  if (layout.showWeekNumbers) {
    doc.save();
    doc.fillColor(EXPORT_COLORS.weekColumnBg)
      .rect(gridX, gridTop, weekColumnWidth, weekdayRowHeight)
      .fill();
    doc.restore();
    gridX += weekColumnWidth;
  }

  layout.weekdayHeaders.forEach((label, index) => {
    const x = gridX + index * dayColumnWidth;
    doc.save();
    doc.fillColor(EXPORT_COLORS.weekdayHeaderBg).rect(x, gridTop, dayColumnWidth, weekdayRowHeight).fill();
    doc.lineWidth(0.5).strokeColor(EXPORT_COLORS.border).rect(x, gridTop, dayColumnWidth, weekdayRowHeight).stroke();
    doc.fillColor(getWeekdayHeaderColor(index, layout.weekStartsOn))
      .fontSize(10)
      .text(label, x, gridTop + 5, { width: dayColumnWidth, align: 'center', lineBreak: false });
    doc.restore();
  });

  return { gridX, bodyStartY: gridTop + weekdayRowHeight };
}

/**
 * @param {import('pdfkit').default} doc
 * @param {ReturnType<typeof prepareMonthExportLayout>} layout
 * @param {object} week
 * @param {number} weekRowHeight
 * @param {number} rowY
 * @param {number} margin
 * @param {number} gridX
 * @param {number} weekColumnWidth
 * @param {number} dayColumnWidth
 */
function drawPdfWeekRow(doc, layout, week, weekRowHeight, rowY, margin, gridX, weekColumnWidth, dayColumnWidth) {
  if (layout.showWeekNumbers) {
    doc.save();
    doc.fillColor(EXPORT_COLORS.weekColumnBg).rect(margin, rowY, weekColumnWidth, weekRowHeight).fill();
    doc.lineWidth(0.5).strokeColor(EXPORT_COLORS.border).rect(margin, rowY, weekColumnWidth, weekRowHeight).stroke();
    doc.fillColor(EXPORT_COLORS.muted)
      .fontSize(9)
      .text(String(week.weekNumber), margin, rowY + 8, { width: weekColumnWidth, align: 'center', lineBreak: false });
    doc.restore();
  }

  week.days.forEach((day, dayIndex) => {
    const x = gridX + dayIndex * dayColumnWidth;
    drawPdfDayCell(doc, day, x, rowY, dayColumnWidth, weekRowHeight);
  });
}

function drawPdfDayCell(doc, day, x, y, width, height) {
  doc.save();
  doc.lineWidth(0.5).strokeColor(EXPORT_COLORS.border).rect(x, y, width, height).stroke();

  if (day.isToday) {
    doc.fillColor(EXPORT_COLORS.todayBg).rect(x, y, width, height).fill();
    doc.lineWidth(0.5).strokeColor(EXPORT_COLORS.border).rect(x, y, width, height).stroke();
  }

  const solarX = x + 6;
  const solarY = y + 6;
  const solarSize = 14;
  const lunarGap = 14;
  const solarText = String(day.solar);
  const solarSlotWidth = doc.widthOfString('30', { size: solarSize });

  doc.fillColor(day.solarColor).fontSize(solarSize).text(solarText, solarX, solarY, { lineBreak: false });

  if (day.lunarLabel) {
    const lunarColor = day.inMonth ? EXPORT_COLORS.muted : EXPORT_COLORS.otherMonth;
    doc.fillColor(lunarColor)
      .fontSize(8)
      .text(
        `(${day.lunarLabel})`,
        solarX + solarSlotWidth + lunarGap,
        solarY + 2,
        { lineBreak: false },
      );
  }

  doc.save();
  doc.rect(x, y, width, height).clip();

  let eventY = y + 24;
  const textWidth = getPdfEventTextWidth(width);

  day.events.forEach((event) => {
    const stripeX = x + PDF_CELL_PADDING;
    const textX = stripeX + PDF_STRIPE_WIDTH + PDF_TEXT_GAP;
    const textHeight = measurePdfEventTextHeight(doc, event.line, textWidth);
    const blockHeight = Math.max(PDF_MIN_EVENT_BAR_HEIGHT, textHeight);

    doc.fillColor(event.color).rect(stripeX, eventY + 1, PDF_STRIPE_WIDTH, blockHeight).fill();
    doc.fillColor(EXPORT_COLORS.body)
      .fontSize(PDF_EVENT_FONT_SIZE)
      .text(event.line, textX, eventY, { width: textWidth, lineBreak: true });
    eventY += blockHeight + PDF_EVENT_GAP;
  });

  doc.restore();
  doc.restore();
}

/**
 * @param {ReturnType<typeof prepareMonthExportLayout>} layout
 */
async function buildPdfCalendarBuffer(layout) {
  const fontBuffer = await loadKoreanFontBuffer();
  // PDFKit defaults to Helvetica via fs/__dirname (Node-only). Pass the
  // embedded font up front so browser/WebView never touches standard AFM files.
  const fontBytes = uint8FromBufferLike(fontBuffer);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 28,
      font: fontBytes,
    });
    /** @type {Uint8Array[]} */
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(uint8FromBufferLike(chunk)));
    doc.on('end', () => {
      const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      resolve(out);
    });
    doc.on('error', reject);

    doc.registerFont('Body', fontBytes);
    doc.font('Body');

    const margin = 28;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const contentWidth = pageWidth - margin * 2;
    const weekColumnWidth = layout.showWeekNumbers ? 28 : 0;
    const dayColumnWidth = (contentWidth - weekColumnWidth) / 7;
    const titleHeight = 40;
    const weekdayRowHeight = 20;
    const headerBlockHeight = titleHeight + weekdayRowHeight;
    const maxBodyHeight = pageHeight - margin * 2 - headerBlockHeight;
    const weekRowHeights = layout.weekRows.map((week) => getPdfWeekRowHeight(doc, week, dayColumnWidth, 96));

    let bodyStartY = 0;
    let gridX = margin;
    let usedBodyHeight = 0;
    let pageIndex = 0;

    const startNewPage = () => {
      if (pageIndex > 0) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin });
        doc.font('Body');
      }
      pageIndex += 1;
      usedBodyHeight = 0;
      const header = drawPdfPageHeader(
        doc,
        layout,
        margin,
        contentWidth,
        weekColumnWidth,
        dayColumnWidth,
        titleHeight,
        weekdayRowHeight,
      );
      gridX = header.gridX;
      bodyStartY = header.bodyStartY;
    };

    layout.weekRows.forEach((week, weekIndex) => {
      const weekRowHeight = weekRowHeights[weekIndex];

      if (pageIndex === 0 || usedBodyHeight + weekRowHeight > maxBodyHeight) {
        startNewPage();
      }

      drawPdfWeekRow(
        doc,
        layout,
        week,
        weekRowHeight,
        bodyStartY + usedBodyHeight,
        margin,
        gridX,
        weekColumnWidth,
        dayColumnWidth,
      );
      usedBodyHeight += weekRowHeight;
    });

    doc.end();
  });
}

/**
 * @param {object} store
 * @param {{ scope: 'month' | 'year', year: number, month?: number }} period
 * @param {{ asAdmin?: boolean }} [options]
 */
export async function buildExcelBuffer(store, period, options = {}) {
  const layout = prepareMonthExportLayout(store, period, options);
  if (!layout) {
    throw new Error('연간 내보내기는 아직 지원하지 않습니다.');
  }
  return buildExcelCalendarBuffer(layout);
}

/**
 * @param {object} store
 * @param {{ scope: 'month' | 'year', year: number, month?: number }} period
 * @param {{ asAdmin?: boolean }} [options]
 */
export async function buildPdfBuffer(store, period, options = {}) {
  const layout = prepareMonthExportLayout(store, period, options);
  if (!layout) {
    throw new Error('연간 내보내기는 아직 지원하지 않습니다.');
  }
  return buildPdfCalendarBuffer(layout);
}

export function getExcelExportFileName(period) {
  return getExportFileName(period, 'xlsx');
}

export function getPdfExportFileName(period) {
  return getExportFileName(period, 'pdf');
}
