import "./style.css";
import { buildPreviewPath, buildStl, formatSummary, getEarPreviewShapes, resolveTemplate } from "./geometry";
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

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function makeFilename(prefix: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return `${prefix}_${stamp}`;
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
          <div class="actions">
            <button id="apply-config" type="button">Apply Config</button>
            <button id="download-json" type="button" class="secondary">Download JSON</button>
            <button id="download-stl" type="button" class="accent">Download STL</button>
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
            </ul>
          </div>
        </section>

        <section class="panel preview-panel">
          <div class="panel-heading">
            <h2>Preview</h2>
            <p>Preview is 2D, export is STL.</p>
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

  if (!textarea || !status || !summary || !previewSvg || !previewContent || !applyButton || !downloadJsonButton || !downloadStlButton || !exampleSelect) {
    return;
  }

  let currentConfig = cloneConfig(defaultConfig);
  let lastResolved = null as ReturnType<typeof resolveTemplate> | null;

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
      status.innerHTML = `<strong>Config valid.</strong><span> Preview and STL export are ready.</span>`;
      downloadStlButton.disabled = false;
    } catch (error) {
      status.className = "status error";
      status.textContent = error instanceof Error ? error.message : String(error);
      previewContent.innerHTML = "";
      summary.innerHTML = "";
      downloadStlButton.disabled = true;
    }
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
    }
  };

  applyButton.addEventListener("click", applyEditorValue);
  downloadJsonButton.addEventListener("click", () => {
    downloadTextFile(`${makeFilename("template_config")}.json`, textarea.value);
  });
  downloadStlButton.addEventListener("click", () => {
    if (!lastResolved) {
      return;
    }
    const stl = buildStl(lastResolved, makeFilename("template"));
    downloadTextFile(`${makeFilename("template")}.stl`, stl);
  });
  exampleSelect.addEventListener("change", () => {
    const config = examplesById.get(exampleSelect.value);
    if (!config) {
      return;
    }
    currentConfig = cloneConfig(config);
    textarea.value = formatJson(currentConfig);
    renderResolved();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      applyEditorValue();
    }
  });

  renderResolved();
}

renderApp();
