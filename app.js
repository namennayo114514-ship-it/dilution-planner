/* ここから変更
 * INPUT・解析条件: 通常は直接変更せず index.html の入力欄・調製条件を使う。
 * OUTPUT: 操作表とCSV。保存先はブラウザで指定する。
 * ここまで変更 */
"use strict";

const byId = id => document.getElementById(id);
const form = byId("plan-form");
const input = byId("samples");
const labels = { direct: "直接", shared: "共通移送量", custom: "個別移送量", hold: "要確認" };
let current = [];
let demo = false;

function invalidate() {
  current = [];
  byId("results").hidden = true;
  byId("error").hidden = true;
}

function loadDemo() {
  const values = Array.from({ length: 60 }, (_, index) => {
    const id = "S" + String(index + 1).padStart(2, "0");
    const rna = index === 59 ? 50 : 1 + (index * 137 % 490) / 10;
    const dna = 1 + (index * 91 % 490) / 10;
    return `${id},${rna.toFixed(1)},${dna.toFixed(1)}`;
  });
  input.value = ["id,rna,dna", ...values].join("\n");
  demo = true;
  byId("input-kind").textContent = "仮データ";
  calculate();
}

function displayNumber(value) {
  return value == null ? "—" : String(Number(value.toPrecision(6)));
}

function cell(row, content) {
  const td = row.insertCell();
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
}

function render(grid) {
  const ready = current.filter(row => row.kind !== "hold");
  const intermediateWater = ready.reduce((sum, row) => sum + row.intermediateWater, 0);
  const finalWater = ready.reduce((sum, row) => sum + row.finalWater, 0);
  const waste = ready.reduce((sum, row) => sum + row.waste, 0);
  byId("result-context").textContent =
    `${demo ? "仮データ · " : ""}${current.length}件 · 目標 ${displayNumber(grid.final / 1000)} µL / ${displayNumber(grid.mass)} ng · 許容差 ±${displayNumber(grid.tolerance * 100)}%`;
  const metrics = [
    ["調製可能", `${ready.length} / ${current.length}件`],
    ["中間チューブ", `${ready.filter(row => row.kind !== "direct").length}本`],
    ["必要な水", `${displayNumber(intermediateWater + finalWater)} µL`,
      `中間 ${displayNumber(intermediateWater)} µL / 最終 ${displayNumber(finalWater)} µL`],
    ["移送後の中間液残り", `${displayNumber(waste)} µL`]
  ];
  const summary = byId("summary");
  summary.replaceChildren();
  for (const [label, value, breakdown] of metrics) {
    const item = document.createElement("div");
    const title = document.createElement("span");
    const amount = document.createElement("strong");
    title.textContent = label;
    amount.textContent = value;
    item.append(title, amount);
    if (breakdown) {
      const detail = document.createElement("span");
      detail.textContent = breakdown;
      item.append(detail);
    }
    summary.append(item);
  }
  const body = byId("rows");
  body.replaceChildren();
  for (const plan of current) {
    const row = body.insertRow();
    row.className = plan.kind;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.disabled = plan.kind === "hold";
    check.setAttribute("aria-label", `${plan.id} の調製完了`);
    check.addEventListener("change", () => row.classList.toggle("done", check.checked));
    cell(row, check);
    cell(row, plan.id);
    cell(row, displayNumber(plan.rna));
    cell(row, plan.reason || labels[plan.kind]);
    const steps = [
      [plan.kind === "direct" ? null : plan.source, plan.sourcePipette],
      [plan.kind === "direct" ? null : plan.intermediateWater, plan.intermediateWaterPipette],
      [plan.aliquot, plan.aliquotPipette],
      [plan.finalWater, plan.finalWaterPipette]
    ];
    for (const [volume, pipette] of steps) {
      cell(row, volume && pipette ? `${volume} · ${pipette}` : displayNumber(volume));
    }
    cell(row, displayNumber(plan.amount));
  }
  byId("results").hidden = false;
}

function calculate() {
  invalidate();
  if (!form.reportValidity()) return;
  try {
    const settings = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, Number(value)]));
    const grid = prepare(settings);
    current = parseSamples(input.value).map(sample => planSample(sample, grid));
    render(grid);
  } catch (error) {
    byId("error").textContent = error.message;
    byId("error").hidden = false;
  }
}

function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function download() {
  const heading = ["ID", "原液RNA ng/µL", "原液DNA ng/µL", "原液残量 µL", "調製方法",
    "中間 原液 µL", "中間 原液 ピペット", "中間 水 µL", "中間 水 ピペット",
    "最終 原液または中間液 µL", "最終 移送 ピペット", "最終 水 µL", "最終 水 ピペット",
    "RNA見込み ng", "目標との差 %", "中間液残り µL"];
  const rows = current.map(p => [p.id, p.rna, p.dna, p.stock, p.reason || labels[p.kind],
    p.kind === "direct" ? null : p.source, p.kind === "direct" ? null : p.sourcePipette,
    p.kind === "direct" ? null : p.intermediateWater, p.intermediateWaterPipette,
    p.aliquot, p.aliquotPipette, p.finalWater, p.finalWaterPipette, p.amount?.toPrecision(8), p.error?.toFixed(4), p.waste]);
  const csv = [heading, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = demo ? "希釈手順_仮データ.csv" : "希釈手順.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  calculate();
});
form.addEventListener("input", event => {
  if (event.target === input) {
    demo = false;
    byId("input-kind").textContent = "";
  }
  invalidate();
});
byId("demo").addEventListener("click", loadDemo);
byId("export").addEventListener("click", download);
byId("print").addEventListener("click", () => window.print());
loadDemo();
