import "./style.css";
import { buildPreviewPath, buildStl, formatSummary, getEarPreviewShapes, resolveTemplate } from "./geometry";
import { buildTemplatePdf, type PaperFormat } from "./pdf";
import { defaultConfig, exampleAutoFitConfig, type TemplateConfig } from "./model";

interface ExampleChoice {
  id: string;
  label: string;
  config: TemplateConfig;
}

const builtinExamples: ExampleChoice[] = [
  { id: "builtin-fixed", label: "Fixed layout", config: defaultConfig },
  { id: "builtin-auto", label: "Auto-fit layout", config: exampleAutoFitConfig }
];

const exampleFileLabels: Record<string, string> = {
  "handle-096-two-hole": "Handle 96 mm",
  "handle-128-two-hole": "Handle 128 mm",
  "handle-160-two-hole": "Handle 160 mm",
  "handle-192-two-hole": "Handle 192 mm",
  "handle-custom-110-two-hole": "Handle 110 mm",
  "knob-single-hole": "Single knob",
  "corner-template-handle-128": "Corner handle 128 mm",
  "shelf-pin-row-32mm-5holes": "Shelf pin row, 32 mm",
  "hinge-35mm-single": "Hinge 35 mm",
  "hinge-35mm-pair": "Hinge pair 35 mm"
};

const exampleFileOrder = Object.keys(exampleFileLabels);

const exampleFiles = import.meta.glob<TemplateConfig>("../examples/*.json", {
  eager: true,
  import: "default"
});

function exampleIdFromPath(path: string): string {
  const fileName = path.split(/[/\\]/).pop() ?? path;
  return fileName.replace(/\.json$/, "");
}

const fileExamples: ExampleChoice[] = Object.entries(exampleFiles)
  .map(([path, config]) => {
    const id = exampleIdFromPath(path);
    return {
      id,
      label: exampleFileLabels[id] ?? id.replace(/-/g, " "),
      config
    };
  })
  .sort((left, right) => {
    const leftIndex = exampleFileOrder.indexOf(left.id);
    const rightIndex = exampleFileOrder.indexOf(right.id);
    const leftRank = leftIndex === -1 ? exampleFileOrder.length : leftIndex;
    const rightRank = rightIndex === -1 ? exampleFileOrder.length : rightIndex;
    return leftRank - rightRank || left.label.localeCompare(right.label);
  });

const examplesById = new Map<string, TemplateConfig>(
  [...builtinExamples, ...fileExamples].map((example) => [example.id, example.config])
);

function renderExampleOptions(examples: ExampleChoice[]): string {
  return examples
    .map((example) => `<option value="${escapeHtml(example.id)}">${escapeHtml(example.label)}</option>`)
    .join("");
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function formatJson(config: TemplateConfig): string {
  return JSON.stringify(config, null, 2);
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadTextFile(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: "text/plain;charset=utf-8" }));
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Array<{ name: string; content: string }>): Blob {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    central.push(centralHeader);
    offset += local.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...central, end].map(
    (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  return new Blob(parts, { type: "application/zip" });
}

const MAX_VARIABLE_COMBINATIONS = 100;

interface VariableBounds {
  from: string;
  to: string;
  step: string;
}

interface VariableToken {
  name: string;
  start: number;
  end: number;
}

function findVariableTokens(source: string): VariableToken[] {
  const tokens: VariableToken[] = [];
  const namePattern = /^\$([A-Za-z_][A-Za-z0-9_]*)/;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      const quoted = /^"\$([A-Za-z_][A-Za-z0-9_]*)"/.exec(source.slice(index));
      if (quoted) {
        tokens.push({ name: quoted[1], start: index, end: index + quoted[0].length });
        index += quoted[0].length - 1;
        continue;
      }
      inString = true;
      continue;
    }

    if (char === "$") {
      const bare = namePattern.exec(source.slice(index));
      if (bare) {
        tokens.push({ name: bare[1], start: index, end: index + bare[0].length });
        index += bare[0].length - 1;
      }
    }
  }

  return tokens;
}

function detectVariables(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const token of findVariableTokens(source)) {
    if (!seen.has(token.name)) {
      seen.add(token.name);
      names.push(token.name);
    }
  }
  return names;
}

function applyVariableTokens(source: string, variables: Record<string, number>): string {
  let result = "";
  let cursor = 0;
  for (const token of findVariableTokens(source)) {
    if (!(token.name in variables)) {
      continue;
    }
    result += source.slice(cursor, token.start);
    result += String(variables[token.name]);
    cursor = token.end;
  }
  return result + source.slice(cursor);
}

function decimalPlaces(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  const plain = trimmed.includes("e") ? String(Number(trimmed)) : trimmed;
  const dot = plain.indexOf(".");
  return dot === -1 ? 0 : plain.length - dot - 1;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function valuesForRange(name: string, bounds: VariableBounds): number[] {
  if (!bounds.from.trim() || !bounds.to.trim() || !bounds.step.trim()) {
    throw new Error(`Enter from, to, and step for $${name}.`);
  }
  const from = Number(bounds.from);
  const to = Number(bounds.to);
  const step = Number(bounds.step);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step === 0) {
    throw new Error(`From, to, and step for $${name} must be numbers, and step cannot be 0.`);
  }
  if ((to - from) / step < -1e-9) {
    throw new Error(`Step for $${name} must move from ${from} toward ${to}.`);
  }

  const places = decimalPlaces(bounds.step);
  const tolerance = 10 ** -(places + 2);
  const count = Math.floor((to - from) / step + 1e-8) + 1;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = roundTo(from + index * step, places);
    if ((step > 0 && value > to + tolerance) || (step < 0 && value < to - tolerance)) {
      break;
    }
    values.push(value);
  }
  if (values.length === 0) {
    throw new Error(`No values were produced for $${name}.`);
  }
  return values;
}

function expandCombinations(ranges: Array<{ name: string; values: number[] }>): Array<Record<string, number>> {
  let combinations: Array<Record<string, number>> = [{}];
  for (const range of ranges) {
    const next: Array<Record<string, number>> = [];
    for (const combination of combinations) {
      for (const value of range.values) {
        next.push({ ...combination, [range.name]: value });
      }
    }
    combinations = next;
  }
  return combinations;
}

function formatVariableValue(value: number): string {
  return String(value);
}

function sanitizeBaseName(raw: string): string {
  const cleaned = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/^\.+$/, "");
  return cleaned || "template";
}

function variantFilename(base: string, values: Record<string, number>, order: string[]): string {
  const parts = order.map((name) => `${name}-${formatVariableValue(values[name])}`);
  return `${base}_${parts.join("_")}`;
}

const otherProjects: Array<{ title: string; href: string; detail: string }> = [
  {
    title: "Hole Covers STL Generator",
    href: "https://michalmietlinski.github.io/hole-generator/",
    detail: "Parametric hole covers for furniture and cable pass-throughs."
  },
  {
    title: "Text Rectangle Generator",
    href: "https://michalmietlinski.github.io/stl-text-plate/",
    detail: "Rectangular plate with raised text for 3D printing."
  },
  {
    title: "Font to STL",
    href: "https://michalmietlinski.github.io/text-to-stl/",
    detail: "STL letters from TTF or OTF text."
  },
  {
    title: "Washer STL Generator",
    href: "https://michalmietlinski.github.io/washer_generator/",
    detail: "Printable washer STLs from a few dimensions."
  },
  {
    title: "Adapter STL Generator",
    href: "https://michalmietlinski.github.io/adapter-generator/",
    detail: "Hollow adapter between a vacuum hose and a tool port."
  },
  {
    title: "Battery Holder Designer",
    href: "https://michalmietlinski.github.io/battery-holder-generator/",
    detail: "Battery holders from the cell dimensions."
  },
  {
    title: "Box Drawer Divider",
    href: "https://michalmietlinski.github.io/box-drawer-divider-generator/",
    detail: "Divider layouts for boxes and drawers."
  },
  {
    title: "Braille Label Generator",
    href: "https://michalmietlinski.github.io/braille-label-generator/",
    detail: "Braille labels for 3D printing."
  },
  {
    title: "Stencil / form generator",
    href: "https://michalmietlinski.github.io/stencil-form-text-generator/",
    detail: "Cut text as stencil holes or form pockets."
  },
  {
    title: "fast-read",
    href: "https://michalmietlinski.github.io/fastread/",
    detail: "Practice reading faster."
  },
  {
    title: "Warsaw Concerts Calendar",
    href: "https://michalmietlinski.github.io/concerts-list/",
    detail: "Concert listings for Warsaw."
  }
];

function renderOtherProjects(): string {
  return otherProjects
    .map(
      (project) => `
        <a class="project-card" href="${escapeHtml(project.href)}" target="_blank" rel="noopener noreferrer">
          <span class="project-title">${escapeHtml(project.title)}</span>
          <span class="project-detail">${escapeHtml(project.detail)}</span>
        </a>
      `
    )
    .join("");
}

function renderApp(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    return;
  }

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Browser CAD MVP</p>
          <h1>Template Generator</h1>
          <p class="lede">
            Generate a flat drill or alignment template with base-plate edge coordinates, optional ears,
            circular holes, and triangular cut-ins directly in the browser.
          </p>
        </div>
        <label class="example-picker">
          <span>Example</span>
          <select id="example-select">
            <optgroup label="Layouts">
              ${renderExampleOptions(builtinExamples)}
            </optgroup>
            <optgroup label="Hardware">
              ${renderExampleOptions(fileExamples)}
            </optgroup>
          </select>
        </label>
      </header>

      <main class="layout">
        <section class="panel editor-panel">
          <div class="panel-heading">
            <h2>Config</h2>
            <p>Edit the JSON and apply it. This first version is intentionally JSON-first so the geometry rules stay visible while you test the model.</p>
          </div>
          <label class="field-label" for="config-editor">Template Config</label>
          <textarea id="config-editor" spellcheck="false"></textarea>
          <label class="base-name-field" for="base-filename">Base filename <input id="base-filename" type="text" value="template" spellcheck="false"></label>
          <div class="actions">
            <button id="apply-config" type="button">Apply Config</button>
            <button id="download-json" type="button" class="secondary">Download JSON</button>
            <button id="download-stl" type="button" class="accent">Download STL</button>
            <label class="paper-size-field">Paper
              <select id="paper-size" aria-label="Paper size">
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="A2">A2</option>
              </select>
            </label>
            <button id="download-pdf" type="button" class="secondary">Download PDF</button>
          </div>
          <div id="variable-panel" class="notes-card variable-panel" hidden>
            <h3>Variables</h3>
            <p>Write <code>$top</code> where a number belongs. One STL keeps the base filename. Several STLs download together as one zip.</p>
            <div id="variable-fields"></div>
            <div class="actions">
              <button id="generate-variants" type="button" class="secondary">Generate STL files</button>
            </div>
          </div>
          <div class="notes-card">
            <h3>Current Rules</h3>
            <ul>
              <li><strong>x = 0</strong> and <strong>y = 0</strong> stay on the base plate, not the ears.</li>
              <li>Ears stay outside the base plate in <strong>x/y</strong>, stay flat with one plate face, and extend only upward in <strong>z</strong>.</li>
              <li>Supported ear combinations: none, top, top + left, top + right.</li>
              <li>Tabs support <strong>custom</strong> and <strong>full</strong> modes. Full mode spans the whole edge and inherits matching cutouts.</li>
              <li>Cut-ins can be <strong>triangle</strong> or <strong>rectangle</strong>, and full tabs can optionally use a different mirrored cutout shape.</li>
              <li>A cut-in cannot overlap an ear on the same edge.</li>
              <li>Relative spacing supports <strong>center</strong> and <strong>edge</strong> references for holes.</li>
              <li>Write <strong>$name</strong> where a number belongs. Set from, to, and step to generate one STL per combination.</li>
              <li>PDF export is <strong>1:1 mm</strong> on A4, A3, or A2. Print at 100% actual size, not fit-to-page.</li>
            </ul>
          </div>
        </section>

        <section class="panel preview-panel">
          <div class="panel-heading">
            <h2>Preview</h2>
            <p>Preview is 2D. Export is STL, or a 1:1 PDF on A4, A3, or A2.</p>
          </div>
          <div id="status"></div>
          <div id="summary" class="summary"></div>
          <div class="preview-frame">
            <svg id="preview-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-label="Template preview">
              <defs>
                <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
                  <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(126,162,184,0.22)" stroke-width="0.6"></path>
                </pattern>
              </defs>
              <rect class="grid-fill" x="-1000" y="-1000" width="2000" height="2000"></rect>
              <rect class="grid-pattern" x="-1000" y="-1000" width="2000" height="2000"></rect>
              <g id="preview-content"></g>
            </svg>
          </div>
        </section>
      </main>
      <section class="other-projects" aria-labelledby="other-projects-heading">
        <div class="panel-heading">
          <h2 id="other-projects-heading">Other projects</h2>
          <p>More tools on GitHub Pages.</p>
        </div>
        <div class="project-grid">
          ${renderOtherProjects()}
        </div>
      </section>
    </div>
  `;

  const textarea = document.querySelector<HTMLTextAreaElement>("#config-editor");
  const status = document.querySelector<HTMLDivElement>("#status");
  const summary = document.querySelector<HTMLDivElement>("#summary");
  const previewSvg = document.querySelector<SVGSVGElement>("#preview-svg");
  const previewContent = document.querySelector<SVGGElement>("#preview-content");
  const applyButton = document.querySelector<HTMLButtonElement>("#apply-config");
  const downloadJsonButton = document.querySelector<HTMLButtonElement>("#download-json");
  const downloadStlButton = document.querySelector<HTMLButtonElement>("#download-stl");
  const exampleSelect = document.querySelector<HTMLSelectElement>("#example-select");
  const variablePanel = document.querySelector<HTMLDivElement>("#variable-panel");
  const variableFields = document.querySelector<HTMLDivElement>("#variable-fields");
  const generateVariantsButton = document.querySelector<HTMLButtonElement>("#generate-variants");
  const baseFilenameInput = document.querySelector<HTMLInputElement>("#base-filename");
  const paperSizeSelect = document.querySelector<HTMLSelectElement>("#paper-size");
  const downloadPdfButton = document.querySelector<HTMLButtonElement>("#download-pdf");

  if (!textarea || !status || !summary || !previewSvg || !previewContent || !applyButton || !downloadJsonButton || !downloadStlButton || !exampleSelect || !variablePanel || !variableFields || !generateVariantsButton || !baseFilenameInput || !paperSizeSelect || !downloadPdfButton) {
    return;
  }

  let currentConfig = cloneConfig(defaultConfig);
  let lastResolved = null as ReturnType<typeof resolveTemplate> | null;
  const variableRanges = new Map<string, VariableBounds>();

  textarea.value = formatJson(currentConfig);

  const renderResolved = (): void => {
    try {
      lastResolved = resolveTemplate(currentConfig);
      const resolved = lastResolved;
      const previewPath = buildPreviewPath(resolved.baseShape);
      const earShapes = getEarPreviewShapes(resolved);
      const padding = 12;
      const width = resolved.bounds.maxX - resolved.bounds.minX;
      const height = resolved.bounds.maxY - resolved.bounds.minY;
      previewSvg.setAttribute(
        "viewBox",
        `${resolved.bounds.minX - padding} ${resolved.bounds.minY - padding} ${Math.max(width + padding * 2, 40)} ${Math.max(height + padding * 2, 40)}`
      );

      const holeMarks = resolved.holes
        .map(
          (hole) =>
            `<g><circle class="hole-mark" cx="${hole.x}" cy="${hole.y}" r="${hole.radius}"></circle><circle class="hole-center" cx="${hole.x}" cy="${hole.y}" r="0.8"></circle><text class="feature-label" x="${hole.x + hole.radius + 2}" y="${hole.y - 2}">${escapeHtml(hole.id)}</text></g>`
        )
        .join("");

      const cutInGuides = resolved.cutIns
        .map((cutIn) => {
          const midX = resolved.plate.width ;
          const midY = resolved.plate.height;
          if (cutIn.edge === "top") {
            return `<line class="cutin-guide" x1="${cutIn.anchorX}" y1="0" x2="${cutIn.anchorX}" y2="${midY}"></line>`;
          }
          if (cutIn.edge === "left") {
            return `<line class="cutin-guide" x1="0" y1="${cutIn.anchorY}" x2="${midX}" y2="${cutIn.anchorY}"></line>`;
          }
          return `<line class="cutin-guide" x1="${resolved.plate.width}" y1="${cutIn.anchorY}" x2="${midX}" y2="${cutIn.anchorY}"></line>`;
        })
        .join("");

      const cutInMarks = resolved.cutIns
        .map((cutIn) => {
          const x = cutIn.edge === "top" ? cutIn.anchorX + 2 : cutIn.edge === "left" ? 2 : resolved.plate.width - cutIn.depth - 12;
          const y = cutIn.edge === "top" ? 6 : cutIn.anchorY - 4;
          return `<text class="feature-label cutin-label" x="${x}" y="${y}">${escapeHtml(cutIn.id)}</text>`;
        })
        .join("");

      const earPaths = earShapes
        .map(({ tab, shape }) => {
          const d = buildPreviewPath(shape);
          const firstPoint = shape[0]?.[0]?.[0] ?? [0, 0];
          return `<path class="ear-overlay" d="${d}" fill-rule="evenodd"></path><text class="feature-label ear-label" x="${firstPoint[0] + 2}" y="${firstPoint[1] + 4}">${escapeHtml(tab.id)} ${escapeHtml(tab.mode)} z=${tab.height}</text>`;
        })
        .join("");

      previewContent.innerHTML = `
        <path class="template-fill" d="${previewPath}" fill-rule="evenodd"></path>
        ${earPaths}
        ${cutInGuides}
        <line class="axis-line" x1="0" y1="${resolved.bounds.minY - padding}" x2="0" y2="${resolved.bounds.maxY + padding}"></line>
        <line class="axis-line" x1="${resolved.bounds.minX - padding}" y1="0" x2="${resolved.bounds.maxX + padding}" y2="0"></line>
        <text class="axis-label" x="2" y="${resolved.bounds.minY - 2}">x = 0</text>
        <text class="axis-label" x="${resolved.bounds.minX + 2}" y="-2">y = 0</text>
        ${holeMarks}
        ${cutInMarks}
      `;

      summary.innerHTML = `
        <div class="summary-grid">
          ${formatSummary(resolved)
            .map((line) => `<div class="summary-item">${escapeHtml(line)}</div>`)
            .join("")}
        </div>
        <ul class="note-list">
          ${resolved.notes.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
        </ul>
      `;

      status.className = "status ok";
      status.innerHTML = `<strong>Config valid.</strong><span> Preview, STL, and 1:1 PDF export are ready.</span>`;
      downloadStlButton.disabled = false;
      downloadPdfButton.disabled = false;
    } catch (error) {
      status.className = "status error";
      status.textContent = error instanceof Error ? error.message : String(error);
      previewContent.innerHTML = "";
      summary.innerHTML = "";
      downloadStlButton.disabled = true;
      downloadPdfButton.disabled = true;
    }
  };

  const rememberVariableInputs = (): void => {
    for (const input of variableFields.querySelectorAll<HTMLInputElement>("[data-variable]")) {
      const name = input.dataset.variable;
      const bound = input.dataset.bound;
      if (!name || (bound !== "from" && bound !== "to" && bound !== "step")) {
        continue;
      }
      const current = variableRanges.get(name) ?? { from: "", to: "", step: "" };
      current[bound] = input.value;
      variableRanges.set(name, current);
    }
  };

  const renderVariableFields = (): void => {
    rememberVariableInputs();
    const names = detectVariables(textarea.value);
    variablePanel.hidden = names.length === 0;
    if (names.length === 0) {
      variableFields.innerHTML = "";
      return;
    }

    const active = new Set(names);
    for (const name of variableRanges.keys()) {
      if (!active.has(name)) {
        variableRanges.delete(name);
      }
    }

    variableFields.innerHTML = names
      .map((name) => {
        const bounds = variableRanges.get(name) ?? { from: "", to: "", step: "" };
        variableRanges.set(name, bounds);
        return `
          <div class="variable-row">
            <span class="variable-name">$${escapeHtml(name)}</span>
            <label>From <input data-variable="${escapeHtml(name)}" data-bound="from" inputmode="decimal" value="${escapeHtml(bounds.from)}"></label>
            <label>To <input data-variable="${escapeHtml(name)}" data-bound="to" inputmode="decimal" value="${escapeHtml(bounds.to)}"></label>
            <label>Step <input data-variable="${escapeHtml(name)}" data-bound="step" inputmode="decimal" value="${escapeHtml(bounds.step)}"></label>
          </div>
        `;
      })
      .join("");
  };

  const applyEditorValue = (): void => {
    try {
      const parsed = JSON.parse(textarea.value) as TemplateConfig;
      currentConfig = parsed;
      renderResolved();
    } catch (error) {
      status.className = "status error";
      status.textContent = error instanceof Error ? error.message : String(error);
      previewContent.innerHTML = "";
      summary.innerHTML = "";
      downloadStlButton.disabled = true;
      downloadPdfButton.disabled = true;
    }
  };

  const readBaseName = (): string => sanitizeBaseName(baseFilenameInput.value);

  applyButton.addEventListener("click", applyEditorValue);
  downloadJsonButton.addEventListener("click", () => {
    downloadTextFile(`${readBaseName()}.json`, textarea.value);
  });
  downloadStlButton.addEventListener("click", () => {
    if (!lastResolved) {
      return;
    }
    const baseName = readBaseName();
    const stl = buildStl(lastResolved, baseName);
    downloadTextFile(`${baseName}.stl`, stl);
  });
  downloadPdfButton.addEventListener("click", () => {
    if (!lastResolved) {
      return;
    }
    const selected = paperSizeSelect.value;
    const format: PaperFormat = selected === "A3" || selected === "A2" ? selected : "A4";
    const pdf = buildTemplatePdf(lastResolved, format);
    downloadBlob(`${readBaseName()}.pdf`, new Blob([pdf.data], { type: "application/pdf" }));
    status.className = "status ok";
    status.innerHTML = `<strong>Downloaded ${escapeHtml(readBaseName())}.pdf.</strong><span> ${escapeHtml(pdf.summary)}. In the print dialog, choose actual size.</span>`;
  });
  generateVariantsButton.addEventListener("click", () => {
    rememberVariableInputs();
    try {
      const names = detectVariables(textarea.value);
      if (names.length === 0) {
        throw new Error("Add a $name token where a number belongs before generating files.");
      }
      const ranges = names.map((name) => ({
        name,
        values: valuesForRange(name, variableRanges.get(name) ?? { from: "", to: "", step: "" })
      }));
      const combinations = expandCombinations(ranges);
      if (combinations.length > MAX_VARIABLE_COMBINATIONS) {
        throw new Error(`This range produces ${combinations.length} files. Keep it to ${MAX_VARIABLE_COMBINATIONS} or fewer.`);
      }

      const baseName = readBaseName();
      const files = combinations.map((combination) => {
        const config = JSON.parse(applyVariableTokens(textarea.value, combination)) as TemplateConfig;
        const resolved = resolveTemplate(config);
        const stem = variantFilename(baseName, combination, names);
        return { name: `${stem}.stl`, content: buildStl(resolved, stem) };
      });

      if (files.length === 1) {
        downloadTextFile(files[0].name, files[0].content);
      } else {
        downloadBlob(`${baseName}.zip`, buildZip(files));
      }

      const savedName = files.length === 1 ? files[0].name : `${baseName}.zip`;
      status.className = "status ok";
      status.innerHTML = `<strong>Downloaded ${escapeHtml(savedName)}.</strong><span> ${escapeHtml(files.map((file) => file.name).join(", "))}</span>`;
    } catch (error) {
      status.className = "status error";
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  exampleSelect.addEventListener("change", () => {
    const config = examplesById.get(exampleSelect.value);
    if (!config) {
      return;
    }
    currentConfig = cloneConfig(config);
    textarea.value = formatJson(currentConfig);
    renderVariableFields();
    renderResolved();
  });
  textarea.addEventListener("input", renderVariableFields);
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      applyEditorValue();
    }
  });

  renderVariableFields();
  renderResolved();
}

renderApp();
