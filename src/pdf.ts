import { getEarPreviewShapes } from "./geometry";
import type { Bounds, MultiPolygon, ResolvedTemplate, Ring } from "./model";

export type PaperFormat = "A4" | "A3" | "A2";

const PAPER_MM: Record<PaperFormat, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  A2: { width: 420, height: 594 }
};

const MM_TO_PT = 72 / 25.4;
const PAGE_MARGIN_MM = 10;
const SCALE_BAR_MM = 20;

export interface TemplatePdf {
  data: string;
  summary: string;
}

interface PageLayout {
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  usableWidth: number;
  usableHeight: number;
  columns: number;
  rows: number;
}

function fmt(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded);
}

function pdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function ringPath(ring: Ring): string {
  if (ring.length === 0) {
    return "";
  }
  const commands = [`${fmt(ring[0][0])} ${fmt(ring[0][1])} m`];
  for (let index = 1; index < ring.length; index += 1) {
    commands.push(`${fmt(ring[index][0])} ${fmt(ring[index][1])} l`);
  }
  commands.push("h");
  return commands.join("\n");
}

function shapePath(shape: MultiPolygon): string {
  return shape
    .flatMap((polygon) => polygon.map((ring) => ringPath(ring)))
    .filter((path) => path.length > 0)
    .join("\n");
}

function pageCountFor(contentWidth: number, contentHeight: number, usableWidth: number, usableHeight: number): number {
  const columns = Math.max(1, Math.ceil((contentWidth - 1e-6) / usableWidth));
  const rows = Math.max(1, Math.ceil((contentHeight - 1e-6) / usableHeight));
  return columns * rows;
}

function chooseLayout(bounds: Bounds, format: PaperFormat): PageLayout {
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  const paper = PAPER_MM[format];
  const candidates = [
    { orientation: "portrait" as const, width: paper.width, height: paper.height },
    { orientation: "landscape" as const, width: paper.height, height: paper.width }
  ].map((candidate) => {
    const usableWidth = candidate.width - PAGE_MARGIN_MM * 2;
    const usableHeight = candidate.height - PAGE_MARGIN_MM * 2;
    return {
      ...candidate,
      usableWidth,
      usableHeight,
      columns: Math.max(1, Math.ceil((contentWidth - 1e-6) / usableWidth)),
      rows: Math.max(1, Math.ceil((contentHeight - 1e-6) / usableHeight)),
      pages: pageCountFor(contentWidth, contentHeight, usableWidth, usableHeight)
    };
  });

  const fitting = candidates.filter((candidate) => candidate.pages === 1);
  const chosen = fitting.find((candidate) => candidate.orientation === (contentHeight >= contentWidth ? "portrait" : "landscape"))
    ?? fitting[0]
    ?? candidates.slice().sort((left, right) => left.pages - right.pages || left.width - right.width)[0];

  return chosen;
}

function guideLines(resolved: ResolvedTemplate): Array<[number, number, number, number]> {
  return resolved.cutIns.map((cutIn) => {
    if (cutIn.edge === "top") {
      return [cutIn.anchorX, 0, cutIn.anchorX, resolved.plate.height];
    }
    if (cutIn.edge === "left") {
      return [0, cutIn.anchorY, resolved.plate.width, cutIn.anchorY];
    }
    return [resolved.plate.width, cutIn.anchorY, resolved.plate.width, cutIn.anchorY];
  });
}

function designStream(resolved: ResolvedTemplate, layout: PageLayout, column: number, row: number): string {
  const viewMinX = resolved.bounds.minX + column * layout.usableWidth;
  const viewMinY = resolved.bounds.minY + row * layout.usableHeight;
  const pageWidthPt = layout.width * MM_TO_PT;
  const pageHeightPt = layout.height * MM_TO_PT;
  const marginPt = PAGE_MARGIN_MM * MM_TO_PT;
  const translateX = marginPt - viewMinX * MM_TO_PT;
  const translateY = pageHeightPt - marginPt + viewMinY * MM_TO_PT;
  const commands: string[] = [
    "q",
    `${fmt(marginPt)} ${fmt(marginPt)} ${fmt(pageWidthPt - marginPt * 2)} ${fmt(pageHeightPt - marginPt * 2)} re W n`,
    `${fmt(MM_TO_PT)} 0 0 ${fmt(-MM_TO_PT)} ${fmt(translateX)} ${fmt(translateY)} cm`
  ];

  const earPath = shapePath(getEarPreviewShapes(resolved).map((ear) => ear.shape).flat());
  if (earPath) {
    commands.push("0.85 0.91 0.91 rg", "0.05 0.37 0.40 RG", "0.25 w", earPath, "B*");
  }

  const platePath = shapePath(resolved.baseShape);
  if (platePath) {
    commands.push("0.96 0.91 0.86 rg", "0.55 0.25 0.12 RG", "0.25 w", platePath, "B*");
  }

  const guides = guideLines(resolved).filter((line) => line[0] !== line[2] || line[1] !== line[3]);
  if (guides.length > 0) {
    commands.push("0.55 0.2 0.06 RG", "0.18 w", "[1.6 1.1] 0 d");
    for (const [x1, y1, x2, y2] of guides) {
      commands.push(`${fmt(x1)} ${fmt(y1)} m`, `${fmt(x2)} ${fmt(y2)} l`);
    }
    commands.push("S", "[] 0 d");
  }

  if (resolved.holes.length > 0) {
    commands.push("0.05 0.25 0.28 RG", "0.15 w");
    for (const hole of resolved.holes) {
      const arm = Math.min(1.5, hole.radius * 0.7);
      commands.push(
        `${fmt(hole.x - arm)} ${fmt(hole.y)} m`,
        `${fmt(hole.x + arm)} ${fmt(hole.y)} l`,
        `${fmt(hole.x)} ${fmt(hole.y - arm)} m`,
        `${fmt(hole.x)} ${fmt(hole.y + arm)} l`
      );
    }
    commands.push("S");
  }

  commands.push("Q");

  const barX = marginPt;
  const barY = pageHeightPt - 6 * MM_TO_PT;
  const barLength = SCALE_BAR_MM * MM_TO_PT;
  const tick = 1.5 * MM_TO_PT;
  commands.push(
    "q",
    "0 0 0 RG",
    "0.6 w",
    `${fmt(barX)} ${fmt(barY)} m`,
    `${fmt(barX + barLength)} ${fmt(barY)} l`,
    `${fmt(barX)} ${fmt(barY - tick)} m`,
    `${fmt(barX)} ${fmt(barY + tick)} l`,
    `${fmt(barX + barLength)} ${fmt(barY - tick)} m`,
    `${fmt(barX + barLength)} ${fmt(barY + tick)} l`,
    "S",
    "Q",
    "BT",
    "/F1 8 Tf",
    `${fmt(barX + barLength + 4)} ${fmt(barY - 2)} Td`,
    "(20 mm) Tj",
    "ET"
  );

  const pageNumber = row * layout.columns + column + 1;
  const pageTotal = layout.columns * layout.rows;
  const note = `1:1 mm. Print at 100% actual size, not fit-to-page. ${layout.orientation}. Page ${pageNumber}/${pageTotal}. Plate ${resolved.plate.width.toFixed(1)} x ${resolved.plate.height.toFixed(1)} mm.`;
  commands.push(
    "0 0 0 rg",
    "BT",
    "/F1 8 Tf",
    `${fmt(marginPt)} ${fmt(4 * MM_TO_PT)} Td`,
    `(${pdfText(note)}) Tj`,
    "ET"
  );

  return commands.join("\n");
}

function buildDocument(pageStreams: string[], layout: PageLayout): string {
  const pageWidthPt = fmt(layout.width * MM_TO_PT);
  const pageHeightPt = fmt(layout.height * MM_TO_PT);
  const fontId = 3;
  const pageIds = pageStreams.map((_, index) => 4 + index * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageStreams.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  pageStreams.forEach((stream, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt} ${pageHeightPt}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

export function buildTemplatePdf(resolved: ResolvedTemplate, format: PaperFormat): TemplatePdf {
  const layout = chooseLayout(resolved.bounds, format);
  const streams: string[] = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      streams.push(designStream(resolved, layout, column, row));
    }
  }

  const pageLabel = streams.length === 1 ? "1 page" : `${streams.length} pages`;
  return {
    data: buildDocument(streams, layout),
    summary: `${format} ${layout.orientation}, ${pageLabel}, 1:1 mm`
  };
}
