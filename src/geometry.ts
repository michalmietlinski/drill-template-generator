import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import type {
  Bounds,
  CutInConfig,
  EarConfig,
  EarMode,
  MultiPolygon,
  Point,
  Polygon,
  RelativePosition,
  ResolvedCutIn,
  ResolvedHole,
  ResolvedPlate,
  ResolvedTemplate,
  Ring,
  TemplateConfig
} from "./model";

const CIRCLE_SEGMENTS = 48;
const EPSILON = 1e-6;

interface ResolvedAnchor {
  id: string;
  x: number;
  y: number;
  halfSpanX: number;
  halfSpanY: number;
}

function assertFinite(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return number;
}

function assertPositive(value: number, label: string): number {
  if (value <= 0) {
    throw new Error(`${label} must be > 0.`);
  }
  return value;
}

function normalizeRelativeReference(value: unknown): "center" | "edge" {
  return String(value || "center").toLowerCase() === "edge" ? "edge" : "center";
}

function normalizeRelativeSide(value: unknown): "positive" | "negative" {
  return String(value || "positive").toLowerCase() === "negative" ? "negative" : "positive";
}

function normalizeAxis(value: unknown, label: string): "x" | "y" {
  const axis = String(value || "").toLowerCase();
  if (axis !== "x" && axis !== "y") {
    throw new Error(`${label} must be "x" or "y".`);
  }
  return axis;
}

function signedArea(ring: Ring): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
}

function normalizeRing(rawRing: number[][]): Ring {
  const ring = rawRing.map((point) => [point[0], point[1]] as Point);
  if (ring.length >= 2 && samePoint(ring[0], ring[ring.length - 1])) {
    ring.pop();
  }
  return ring;
}

function normalizeMultiPolygon(rawGeometry: unknown): MultiPolygon {
  if (!Array.isArray(rawGeometry)) {
    throw new Error("Geometry engine returned an invalid shape.");
  }

  return rawGeometry.map((polygon) => {
    if (!Array.isArray(polygon)) {
      throw new Error("Geometry engine returned an invalid polygon.");
    }

    return polygon.map((ring) => {
      if (!Array.isArray(ring)) {
        throw new Error("Geometry engine returned an invalid ring.");
      }
      return normalizeRing(ring as number[][]);
    });
  });
}

function polygonFromRing(ring: Ring): number[][][] {
  return [ring.map((point) => [point[0], point[1]])];
}

function rectangleRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ];
}

function circleRing(centerX: number, centerY: number, radius: number): Ring {
  const ring: Ring = [];
  for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
    const angle = (Math.PI * 2 * index) / CIRCLE_SEGMENTS;
    ring.push([
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius
    ]);
  }
  return ring;
}

function getCutInShape(cutIn: ResolvedCutIn, context: "plate" | "tab"): "triangle" | "rectangle" {
  return context === "tab" ? cutIn.tabShape ?? cutIn.shape : cutIn.shape;
}

function cutInRingForShape(
  shape: "triangle" | "rectangle",
  cutIn: ResolvedCutIn,
  plate: ResolvedPlate,
  context: "plate" | "tab"
): Ring {
  const direction = context === "plate" ? 1 : -1;

  if (shape === "rectangle") {
    if (cutIn.edge === "top") {
      const y0 = direction < 0 ? -cutIn.depth : 0;
      const y1 = direction < 0 ? 0 : cutIn.depth;
      return rectangleRing(cutIn.anchorX - cutIn.width / 2, y0, cutIn.anchorX + cutIn.width / 2, y1);
    }

    if (cutIn.edge === "left") {
      const x0 = direction < 0 ? -cutIn.depth : 0;
      const x1 = direction < 0 ? 0 : cutIn.depth;
      return rectangleRing(x0, cutIn.anchorY - cutIn.width / 2, x1, cutIn.anchorY + cutIn.width / 2);
    }

    return rectangleRing(
      direction < 0 ? plate.width : plate.width - cutIn.depth,
      cutIn.anchorY - cutIn.width / 2,
      direction < 0 ? plate.width + cutIn.depth : plate.width,
      cutIn.anchorY + cutIn.width / 2
    );
  }

  if (cutIn.edge === "top") {
    return [
      [cutIn.anchorX - cutIn.width / 2, 0],
      [cutIn.anchorX + cutIn.width / 2, 0],
      [cutIn.anchorX, direction < 0 ? -cutIn.depth : cutIn.depth]
    ];
  }

  if (cutIn.edge === "left") {
    return [
      [0, cutIn.anchorY - cutIn.width / 2],
      [0, cutIn.anchorY + cutIn.width / 2],
      [direction < 0 ? -cutIn.depth : cutIn.depth, cutIn.anchorY]
    ];
  }

  return [
    [plate.width, cutIn.anchorY - cutIn.width / 2],
    [plate.width, cutIn.anchorY + cutIn.width / 2],
    [direction < 0 ? plate.width + cutIn.depth : plate.width - cutIn.depth, cutIn.anchorY]
  ];
}

function cutInRing(cutIn: ResolvedCutIn, plate: ResolvedPlate): Ring {
  return cutInRingForShape(getCutInShape(cutIn, "plate"), cutIn, plate, "plate");
}

function earRing(tab: EarConfig, plate: ResolvedPlate): Ring {
  const span = getTabSpan(tab, plate);
  if (tab.side === "top") {
    return rectangleRing(span.start, -tab.depth, span.end, 0);
  }

  if (tab.side === "left") {
    return rectangleRing(-tab.depth, span.start, 0, span.end);
  }

  return rectangleRing(plate.width, span.start, plate.width + tab.depth, span.end);
}

function getTabSpan(tab: EarConfig, plate: ResolvedPlate): { start: number; end: number } {
  if (tab.mode === "full") {
    return tab.side === "top"
      ? { start: 0, end: plate.width }
      : { start: 0, end: plate.height };
  }

  return { start: tab.offset, end: tab.offset + tab.length };
}

function mirrorCutInForTab(cutIn: ResolvedCutIn, plate: ResolvedPlate): Ring {
  return cutInRingForShape(getCutInShape(cutIn, "tab"), cutIn, plate, "tab");
}

function buildTabShape(tab: EarConfig, plate: ResolvedPlate, cutIns: ResolvedCutIn[]): MultiPolygon {
  let geometry = polygonClipping.union(polygonFromRing(earRing(tab, plate)));

  if (tab.mode === "full") {
    const sameEdgeCutIns = cutIns.filter((cutIn) => cutIn.edge === tab.side);
    const subtractors = sameEdgeCutIns.map((cutIn) => polygonFromRing(mirrorCutInForTab(cutIn, plate)));
    if (subtractors.length > 0) {
      geometry = polygonClipping.difference(geometry, ...subtractors);
    }
  }

  return normalizeMultiPolygon(geometry);
}

function resolveRelativeOffset(
  referenceFeature: ResolvedAnchor,
  currentFeature: ResolvedAnchor,
  position: RelativePosition
): number {
  const distance = assertFinite(position.distance, "relative.distance");
  const sign = normalizeRelativeSide(position.side) === "negative" ? -1 : 1;
  if (normalizeRelativeReference(position.reference) === "center") {
    return distance * sign;
  }

  const axis = normalizeAxis(position.axis, "relative.axis");
  const sourceHalfSpan = axis === "x" ? referenceFeature.halfSpanX : referenceFeature.halfSpanY;
  const targetHalfSpan = axis === "x" ? currentFeature.halfSpanX : currentFeature.halfSpanY;
  return (distance + sourceHalfSpan + targetHalfSpan) * sign;
}

function resolveHoles(config: TemplateConfig): ResolvedHole[] {
  const ids = new Set<string>();
  const pending = [...config.holes];
  const resolved = new Map<string, ResolvedHole>();

  for (const hole of config.holes) {
    if (!hole.id.trim()) {
      throw new Error("Each hole requires a non-empty id.");
    }
    if (ids.has(hole.id)) {
      throw new Error(`Duplicate hole id: ${hole.id}`);
    }
    ids.add(hole.id);
    assertPositive(assertFinite(hole.diameter, `hole ${hole.id} diameter`), `hole ${hole.id} diameter`);
  }

  while (pending.length > 0) {
    let progress = false;

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const hole = pending[index];
      const radius = hole.diameter / 2;

      if (hole.position.mode === "absolute") {
        const x = assertFinite(hole.position.x, `hole ${hole.id} position.x`);
        const y = assertFinite(hole.position.y, `hole ${hole.id} position.y`);
        resolved.set(hole.id, { ...hole, radius, x, y });
        pending.splice(index, 1);
        progress = true;
        continue;
      }

      const reference = resolved.get(hole.position.from);
      if (!reference) {
        continue;
      }

      const currentFeature: ResolvedAnchor = {
        id: hole.id,
        x: 0,
        y: 0,
        halfSpanX: radius,
        halfSpanY: radius
      };

      const referenceFeature: ResolvedAnchor = {
        id: reference.id,
        x: reference.x,
        y: reference.y,
        halfSpanX: reference.radius,
        halfSpanY: reference.radius
      };

      const offset = resolveRelativeOffset(referenceFeature, currentFeature, hole.position);
      const axis = normalizeAxis(hole.position.axis, `hole ${hole.id} position.axis`);
      const x = axis === "x" ? reference.x + offset : reference.x;
      const y = axis === "y" ? reference.y + offset : reference.y;

      resolved.set(hole.id, { ...hole, radius, x, y });
      pending.splice(index, 1);
      progress = true;
    }

    if (!progress) {
      const unresolvedIds = pending.map((hole) => hole.id).join(", ");
      throw new Error(
        `Could not resolve hole references. Check for missing or cyclic dependencies: ${unresolvedIds}`
      );
    }
  }

  return config.holes.map((hole) => resolved.get(hole.id) as ResolvedHole);
}

function resolvePlate(config: TemplateConfig, holes: ResolvedHole[]): ResolvedPlate {
  const thickness = assertPositive(assertFinite(config.plate.thickness, "plate.thickness"), "plate.thickness");
  const fallbackWidth = config.plate.width ?? 120;
  const fallbackHeight = config.plate.height ?? 80;

  if (config.plate.sizeMode === "fixed") {
    return {
      width: assertPositive(assertFinite(config.plate.width, "plate.width"), "plate.width"),
      height: assertPositive(assertFinite(config.plate.height, "plate.height"), "plate.height"),
      thickness
    };
  }

  const margin = config.plate.margin ?? {
    left: 10,
    right: 10,
    top: 10,
    bottom: 10
  };

  const leftMargin = assertFinite(margin.left, "plate.margin.left");
  const rightMargin = assertFinite(margin.right, "plate.margin.right");
  const topMargin = assertFinite(margin.top, "plate.margin.top");
  const bottomMargin = assertFinite(margin.bottom, "plate.margin.bottom");

  let width = fallbackWidth;
  let height = fallbackHeight;

  if (holes.length > 0) {
    const minHoleX = Math.min(...holes.map((hole) => hole.x - hole.radius));
    const minHoleY = Math.min(...holes.map((hole) => hole.y - hole.radius));
    const maxHoleX = Math.max(...holes.map((hole) => hole.x + hole.radius));
    const maxHoleY = Math.max(...holes.map((hole) => hole.y + hole.radius));

    if (minHoleX < leftMargin) {
      throw new Error(
        `Auto-fit requires all holes to stay at least ${leftMargin}mm from the left base-plate edge.`
      );
    }
    if (minHoleY < topMargin) {
      throw new Error(
        `Auto-fit requires all holes to stay at least ${topMargin}mm from the top base-plate edge.`
      );
    }

    width = Math.max(fallbackWidth, maxHoleX + rightMargin);
    height = Math.max(fallbackHeight, maxHoleY + bottomMargin);
  }

  return { width, height, thickness };
}

function validateTabs(tabs: EarConfig[], plate: ResolvedPlate): EarConfig[] {
  const activeTabs = tabs.filter((tab) => tab.enabled);
  const sides = activeTabs.map((tab) => tab.side).sort().join(",");
  const allowed = new Set(["", "top", "left,top", "right,top"]);

  if (!allowed.has(sides)) {
    throw new Error("Only these ear combinations are supported: none, top, top + left, top + right.");
  }

  for (const tab of activeTabs) {
    if (!tab.id.trim()) {
      throw new Error("Each tab requires a non-empty id.");
    }
    assertPositive(assertFinite(tab.depth, `tab ${tab.id} depth`), `tab ${tab.id} depth`);
    assertPositive(assertFinite(tab.height, `tab ${tab.id} height`), `tab ${tab.id} height`);
    if (tab.mode === "custom") {
      assertPositive(assertFinite(tab.length, `tab ${tab.id} length`), `tab ${tab.id} length`);
      const offset = assertFinite(tab.offset, `tab ${tab.id} offset`);
      if (offset < 0) {
        throw new Error(`Custom tab ${tab.id} offset must be >= 0.`);
      }
    }
    const span = getTabSpan(tab, plate);
    if (tab.side === "top") {
      if (span.start < 0 || span.end > plate.width) {
        throw new Error(`Top ear ${tab.id} must stay within the base-plate width.`);
      }
      if (tab.depth >= plate.height) {
        throw new Error(`Top ear ${tab.id} depth must stay within the base-plate height.`);
      }
    } else if (span.start < 0 || span.end > plate.height) {
      throw new Error(`Side ear ${tab.id} must stay within the base-plate height.`);
    } else if (tab.depth >= plate.width) {
      throw new Error(`Side ear ${tab.id} depth must stay within the base-plate width.`);
    }
  }

  return activeTabs;
}

function resolveCutIns(
  config: TemplateConfig,
  plate: ResolvedPlate,
  holes: ResolvedHole[]
): ResolvedCutIn[] {
  const ids = new Set<string>();
  const holeMap = new Map(holes.map((hole) => [hole.id, hole]));
  const resolved: ResolvedCutIn[] = [];

  for (const cutIn of config.cutIns) {
    if (!cutIn.id.trim()) {
      throw new Error("Each cut-in requires a non-empty id.");
    }
    if (ids.has(cutIn.id)) {
      throw new Error(`Duplicate cut-in id: ${cutIn.id}`);
    }
    ids.add(cutIn.id);

    if (cutIn.shape !== "triangle" && cutIn.shape !== "rectangle") {
      throw new Error(`Cut-in ${cutIn.id} shape must be "triangle" or "rectangle".`);
    }
    if (cutIn.tabShape != null && cutIn.tabShape !== "triangle" && cutIn.tabShape !== "rectangle") {
      throw new Error(`Cut-in ${cutIn.id} tabShape must be "triangle" or "rectangle" when provided.`);
    }

    assertPositive(assertFinite(cutIn.width, `cut-in ${cutIn.id} width`), `cut-in ${cutIn.id} width`);
    assertPositive(assertFinite(cutIn.depth, `cut-in ${cutIn.id} depth`), `cut-in ${cutIn.id} depth`);

    let anchorX = 0;
    let anchorY = 0;

    if (cutIn.position.mode === "absolute") {
      if (cutIn.edge === "top") {
        anchorX = assertFinite(cutIn.position.x, `cut-in ${cutIn.id} position.x`);
      } else {
        anchorY = assertFinite(cutIn.position.y, `cut-in ${cutIn.id} position.y`);
      }
    } else {
      const reference = holeMap.get(cutIn.position.from);
      if (!reference) {
        throw new Error(`Cut-in ${cutIn.id} can currently reference holes only. Missing: ${cutIn.position.from}`);
      }

      const currentFeature: ResolvedAnchor = {
        id: cutIn.id,
        x: 0,
        y: 0,
        halfSpanX: cutIn.width / 2,
        halfSpanY: cutIn.width / 2
      };
      const referenceFeature: ResolvedAnchor = {
        id: reference.id,
        x: reference.x,
        y: reference.y,
        halfSpanX: reference.radius,
        halfSpanY: reference.radius
      };
      const offset = resolveRelativeOffset(referenceFeature, currentFeature, cutIn.position);
      const axis = normalizeAxis(cutIn.position.axis, `cut-in ${cutIn.id} position.axis`);

      if (cutIn.edge === "top") {
        if (axis !== "x") {
          throw new Error(`Top cut-in ${cutIn.id} must use axis \"x\".`);
        }
        anchorX = reference.x + offset;
      } else {
        if (axis !== "y") {
          throw new Error(`Side cut-in ${cutIn.id} must use axis \"y\".`);
        }
        anchorY = reference.y + offset;
      }
    }

    if (cutIn.edge === "top") {
      if (anchorX - cutIn.width / 2 < 0 || anchorX + cutIn.width / 2 > plate.width) {
        throw new Error(`Top cut-in ${cutIn.id} must stay within the base-plate width.`);
      }
      if (cutIn.depth >= plate.height) {
        throw new Error(`Top cut-in ${cutIn.id} depth must be smaller than plate height.`);
      }
    } else {
      if (anchorY - cutIn.width / 2 < 0 || anchorY + cutIn.width / 2 > plate.height) {
        throw new Error(`Cut-in ${cutIn.id} must stay within the base-plate height.`);
      }
      if (cutIn.depth >= plate.width) {
        throw new Error(`Cut-in ${cutIn.id} depth must be smaller than plate width.`);
      }
    }

    resolved.push({ ...cutIn, anchorX, anchorY });
  }

  return resolved;
}

function buildShape(
  plate: ResolvedPlate,
  holes: ResolvedHole[],
  cutIns: ResolvedCutIn[]
): MultiPolygon {
  let geometry = polygonClipping.union(polygonFromRing(rectangleRing(0, 0, plate.width, plate.height)));

  const subtractors: unknown[] = [];
  for (const hole of holes) {
    subtractors.push(polygonFromRing(circleRing(hole.x, hole.y, hole.radius)));
  }
  for (const cutIn of cutIns) {
    subtractors.push(polygonFromRing(cutInRing(cutIn, plate)));
  }

  if (subtractors.length > 0) {
    geometry = polygonClipping.difference(geometry, ...subtractors);
  }

  const normalized = normalizeMultiPolygon(geometry);
  if (normalized.length === 0) {
    throw new Error("All geometry was removed. Adjust the holes, cut-ins, or plate dimensions.");
  }
  return normalized;
}

function computeBounds(shape: MultiPolygon): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const polygon of shape) {
    for (const ring of polygon) {
      for (const point of ring) {
        minX = Math.min(minX, point[0]);
        minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]);
        maxY = Math.max(maxY, point[1]);
      }
    }
  }

  return { minX, minY, maxX, maxY };
}

function expandBounds(bounds: Bounds, ring: Ring): Bounds {
  let nextBounds = { ...bounds };
  for (const point of ring) {
    nextBounds.minX = Math.min(nextBounds.minX, point[0]);
    nextBounds.minY = Math.min(nextBounds.minY, point[1]);
    nextBounds.maxX = Math.max(nextBounds.maxX, point[0]);
    nextBounds.maxY = Math.max(nextBounds.maxY, point[1]);
  }
  return nextBounds;
}

function computeTemplateBounds(shape: MultiPolygon, plate: ResolvedPlate, activeTabs: EarConfig[]): Bounds {
  let bounds = computeBounds(shape);
  for (const tab of activeTabs) {
    bounds = expandBounds(bounds, earRing(tab, plate));
  }
  return bounds;
}

function validateHoleClearances(holes: ResolvedHole[], plate: ResolvedPlate): void {
  for (const hole of holes) {
    if (hole.x - hole.radius < 0 || hole.x + hole.radius > plate.width) {
      throw new Error(`Hole ${hole.id} leaves the base plate horizontally.`);
    }
    if (hole.y - hole.radius < 0 || hole.y + hole.radius > plate.height) {
      throw new Error(`Hole ${hole.id} leaves the base plate vertically.`);
    }
  }
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function validateCutInsAgainstTabs(cutIns: ResolvedCutIn[], activeTabs: EarConfig[]): void {
  for (const cutIn of cutIns) {
    const cutInStart = (cutIn.edge === "top" ? cutIn.anchorX : cutIn.anchorY) - cutIn.width / 2;
    const cutInEnd = (cutIn.edge === "top" ? cutIn.anchorX : cutIn.anchorY) + cutIn.width / 2;

    for (const tab of activeTabs) {
      if (tab.side !== cutIn.edge) {
        continue;
      }

      if (tab.mode === "full") {
        continue;
      }

      const span = getTabSpan(tab, {
        width: Number.POSITIVE_INFINITY,
        height: Number.POSITIVE_INFINITY,
        thickness: 0
      });
      const tabStart = span.start;
      const tabEnd = span.end;
      if (rangesOverlap(cutInStart, cutInEnd, tabStart, tabEnd)) {
        throw new Error(
          `Cut-in ${cutIn.id} overlaps ear ${tab.id} on the ${cutIn.edge} edge. Remove one of them or move their spans apart.`
        );
      }
    }
  }
}

export function resolveTemplate(config: TemplateConfig): ResolvedTemplate {
  if (config.plate.shape !== "rectangle") {
    throw new Error("Only rectangular base plates are supported.");
  }

  const holes = resolveHoles(config);
  const plate = resolvePlate(config, holes);
  validateHoleClearances(holes, plate);
  const activeTabs = validateTabs(config.tabs, plate);
  const cutIns = resolveCutIns(config, plate, holes);
  validateCutInsAgainstTabs(cutIns, activeTabs);
  const baseShape = buildShape(plate, holes, cutIns);

  return {
    plate,
    activeTabs,
    holes,
    cutIns,
    baseShape,
    bounds: computeTemplateBounds(baseShape, plate, activeTabs),
    notes: [
      config.plate.sizeMode === "auto"
        ? "Auto-fit sizes the base plate from hole extents and margin, then adds ears outside the base rectangle."
        : "Fixed mode uses the exact base-plate width and height from the config.",
      "Ears sit outside the base plate in XY, stay flat against one plate face, and extend only upward from that face in Z.",
      "Cut-ins subtract material from base-plate edges, do not redefine x = 0 or y = 0, and full-length tabs inherit matching cutouts on the same edge."
    ]
  };
}

function pushTriangle(stlLines: string[], triangle: [number, number, number][]): void {
  const [a, b, c] = triangle;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;

  stlLines.push(`  facet normal ${nx / length} ${ny / length} ${nz / length}`);
  stlLines.push("    outer loop");
  stlLines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
  stlLines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
  stlLines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
  stlLines.push("    endloop");
  stlLines.push("  endfacet");
}

function triangulatePolygon(polygon: Polygon): Array<[number, number, number][]> {
  const vertices: number[] = [];
  const holeIndices: number[] = [];
  const points: Point[] = [];

  polygon.forEach((ring, ringIndex) => {
    const normalized = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
    if (ringIndex > 0) {
      holeIndices.push(points.length);
    }
    for (const point of normalized) {
      points.push(point);
      vertices.push(point[0], point[1]);
    }
  });

  const indices = earcut(vertices, holeIndices, 2);
  const triangles: Array<[number, number, number][]> = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = points[indices[index]];
    const b = points[indices[index + 1]];
    const c = points[indices[index + 2]];
    triangles.push([
      [a[0], a[1], 0],
      [b[0], b[1], 0],
      [c[0], c[1], 0]
    ]);
  }

  return triangles;
}

export function buildStl(resolved: ResolvedTemplate, solidName = "template_generator"): string {
  const lines = [`solid ${solidName}`];
  const thickness = resolved.plate.thickness;

  for (const polygon of resolved.baseShape) {
    const topTriangles = triangulatePolygon(polygon);
    for (const triangle of topTriangles) {
      pushTriangle(lines, [
        [triangle[0][0], triangle[0][1], thickness],
        [triangle[1][0], triangle[1][1], thickness],
        [triangle[2][0], triangle[2][1], thickness]
      ]);
      pushTriangle(lines, [triangle[2], triangle[1], triangle[0]]);
    }

    for (const ring of polygon) {
      const normalizedRing = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
      const isOuter = signedArea(ring) >= 0;

      for (let index = 0; index < normalizedRing.length; index += 1) {
        const current = normalizedRing[index];
        const next = normalizedRing[(index + 1) % normalizedRing.length];
        const bottomA: [number, number, number] = [current[0], current[1], 0];
        const bottomB: [number, number, number] = [next[0], next[1], 0];
        const topA: [number, number, number] = [current[0], current[1], thickness];
        const topB: [number, number, number] = [next[0], next[1], thickness];

        if (isOuter) {
          pushTriangle(lines, [bottomA, bottomB, topB]);
          pushTriangle(lines, [bottomA, topB, topA]);
        } else {
          pushTriangle(lines, [bottomA, topB, bottomB]);
          pushTriangle(lines, [bottomA, topA, topB]);
        }
      }
    }
  }

  for (const tab of resolved.activeTabs) {
    const zBottom = 0;
    const zTop = thickness + tab.height;

    for (const polygon of buildTabShape(tab, resolved.plate, resolved.cutIns)) {
      const earTriangles = triangulatePolygon(polygon);
      for (const triangle of earTriangles) {
        pushTriangle(lines, [
          [triangle[0][0], triangle[0][1], zTop],
          [triangle[1][0], triangle[1][1], zTop],
          [triangle[2][0], triangle[2][1], zTop]
        ]);
        pushTriangle(lines, [
          [triangle[2][0], triangle[2][1], zBottom],
          [triangle[1][0], triangle[1][1], zBottom],
          [triangle[0][0], triangle[0][1], zBottom]
        ]);
      }

      for (const ring of polygon) {
        const normalizedRing = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
        const isOuter = signedArea(ring) >= 0;

        for (let index = 0; index < normalizedRing.length; index += 1) {
          const current = normalizedRing[index];
          const next = normalizedRing[(index + 1) % normalizedRing.length];
          const bottomA: [number, number, number] = [current[0], current[1], zBottom];
          const bottomB: [number, number, number] = [next[0], next[1], zBottom];
          const topA: [number, number, number] = [current[0], current[1], zTop];
          const topB: [number, number, number] = [next[0], next[1], zTop];

          if (isOuter) {
            pushTriangle(lines, [bottomA, bottomB, topB]);
            pushTriangle(lines, [bottomA, topB, topA]);
          } else {
            pushTriangle(lines, [bottomA, topB, bottomB]);
            pushTriangle(lines, [bottomA, topA, topB]);
          }
        }
      }
    }
  }

  lines.push(`endsolid ${solidName}`);
  return `${lines.join("\n")}\n`;
}

export function buildPreviewPath(shape: MultiPolygon): string {
  const commands: string[] = [];
  for (const polygon of shape) {
    for (const ring of polygon) {
      if (ring.length === 0) {
        continue;
      }
      commands.push(`M ${ring[0][0]} ${ring[0][1]}`);
      for (let index = 1; index < ring.length; index += 1) {
        commands.push(`L ${ring[index][0]} ${ring[index][1]}`);
      }
      commands.push("Z");
    }
  }
  return commands.join(" ");
}

export function formatSummary(resolved: ResolvedTemplate): string[] {
  return [
    `Base plate: ${resolved.plate.width.toFixed(1)} x ${resolved.plate.height.toFixed(1)} mm`,
    `Thickness: ${resolved.plate.thickness.toFixed(1)} mm`,
    `Ears: ${resolved.activeTabs.length === 0 ? "none" : resolved.activeTabs.map((tab) => `${tab.side} ${tab.mode} (${tab.height.toFixed(1)}mm z)`).join(", ")}`,
    `Holes: ${resolved.holes.length}`,
    `Cut-ins: ${resolved.cutIns.length}`
  ];
}

export function getEarPreviewShapes(resolved: ResolvedTemplate): Array<{ tab: EarConfig; shape: MultiPolygon }> {
  return resolved.activeTabs.map((tab) => ({
    tab,
    shape: buildTabShape(tab, resolved.plate, resolved.cutIns)
  }));
}