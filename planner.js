/* ここから変更
 * INPUT: parseSamples にサンプルID、原液RNA濃度、任意のDNA濃度・原液残量を渡す。
 * 解析条件: 通常は直接変更せず、index.html の「調製条件」で指定する。
 * OUTPUT: 操作表とCSV。保存先はブラウザのダウンロード時に指定する。
 * ここまで変更 */
"use strict";

function parseSamples(input) {
  const lines = input.trim().replace(/^\uFEFF/, "").split(/\r?\n/);
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const split = line => line.split(delimiter).map(cell => cell.trim());
  const header = split(lines[0]).map(cell => cell.toLowerCase());
  const hasHeader = header[0] === "id";
  const columns = hasHeader ? header : ["id", "rna", "dna", "stock"];
  if (hasHeader && (new Set(columns).size !== columns.length ||
      !columns.includes("rna") || columns.some(cell => !["id", "rna", "dna", "stock"].includes(cell)))) {
    throw new Error("見出しには id と rna が必要です。dna と stock は任意です。");
  }
  const samples = [];
  const seen = new Set();
  for (let index = hasHeader ? 1 : 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const values = split(lines[index]);
    const id = values[0];
    if (!id || /["\u0000-\u001F]/.test(id) || values.length > columns.length) {
      throw new Error(`${index + 1}行目のIDまたは列数を確認してください。`);
    }
    if (seen.has(id)) throw new Error(`IDが重複しています。 ${id}`);
    seen.add(id);
    const read = key => {
      const value = values[columns.indexOf(key)];
      if (!value) return null;
      const number = Number(value);
      if (!/^\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(number)) {
        throw new Error(`${index + 1}行目の ${key} は0以上の数値を入力してください。`);
      }
      return number;
    };
    samples.push({ id, rna: read("rna"), dna: read("dna"), stock: read("stock") });
  }
  if (!samples.length) throw new Error("サンプルを入力してください。");
  if (samples.length > 1000) throw new Error("一度に計算できる上限は1,000サンプルです。");
  return samples;
}

const EPS = 1e-8;
function prepare(settings) {
  const { volume, mass, step, min, max, transfer, reserve, tolerance } = settings;
  if (!Object.values(settings).every(Number.isFinite) || mass <= 0 || step <= 0 ||
      volume <= 0 || min <= 0 || max < min || transfer < min || transfer > max ||
      reserve < 0 || tolerance < 0 || tolerance >= 100) {
    throw new Error("調製条件を確認してください。共通移送量は最小・最大分注量の範囲で指定します。");
  }
  const ticks = value => {
    const count = value / step;
    if (!Number.isFinite(count) || Math.abs(count - Math.round(count)) > EPS) {
      throw new Error("体積・分注量・余裕量を分注刻みの倍数で指定してください。");
    }
    return Math.round(count);
  };
  const grid = { final: ticks(volume), min: ticks(min), max: ticks(max),
    transfer: ticks(transfer), reserve: ticks(reserve) };
  if (grid.min < 1 || grid.max > 5000 || grid.final > 2 * grid.max ||
      grid.reserve > 2 * grid.max || grid.transfer > grid.final) {
    throw new Error("最大分注量は刻みの5,000倍までです。最終体積と余裕量は最大分注量の2倍まで、共通移送量は最終体積以下で指定してください。");
  }
  return { ...grid, mass, step, tolerance: tolerance / 100 };
}

function planSample(sample, grid) {
  const { rna, stock } = sample;
  const { final, min, max, transfer, reserve, mass, step, tolerance } = grid;
  const hold = reason => ({ ...sample, kind: "hold", reason });
  if (rna === null || rna === 0) return hold("RNA濃度を確認");
  if (rna * (final * step) / mass < 1 - tolerance - EPS) return hold("最終体積内でRNA量が不足");
  if (stock !== null && rna * stock / mass < 1 - tolerance - EPS) return hold("原液残量が不足");

  const stockMax = stock === null ? max : Math.min(max, Math.floor(stock / step + EPS));
  if (stockMax < min) return hold("原液残量が最小分注量未満");
  const valid = ticks => ticks >= min && ticks <= max;
  const fits = amount => Number.isFinite(amount) && Math.abs(amount / mass - 1) <= tolerance + EPS;
  const ratio = rna * step / mass;
  const toVolume = ticks => Number((ticks * step).toPrecision(12));
  const result = (kind, source, intermediateWater, aliquot, amount) => ({
    ...sample, kind, source: toVolume(source), intermediateWater: toVolume(intermediateWater),
    aliquot: toVolume(aliquot), finalWater: toVolume(final - aliquot),
    waste: kind === "direct" ? 0 : toVolume(source + intermediateWater - aliquot),
    amount, error: (amount / mass - 1) * 100
  });

  const allowed = [];
  let direct;
  for (let aliquot = min; aliquot <= Math.min(max, final); aliquot++) {
    if (final !== aliquot && !valid(final - aliquot)) continue;
    allowed.push(aliquot);
    const amount = rna * toVolume(aliquot);
    if (aliquot <= stockMax && fits(amount) &&
        (!direct || Math.abs(amount - mass) < Math.abs(direct.amount - mass))) {
      direct = result("direct", aliquot, 0, aliquot, amount);
    }
  }
  if (direct) return direct;

  // 採取量を固定したとき、各原液量で許容差を満たす最小の中間水量を調べる。
  function find(aliquots) {
    let best;
    for (const aliquot of aliquots) {
      for (let source = min; source <= stockMax; source++) {
        const minimumTotal = source * aliquot * ratio / (1 + tolerance + EPS);
        if (minimumTotal > source + max) break;
        const total = Math.max(source + min, aliquot + reserve, Math.ceil(minimumTotal));
        if (total > source + max) continue;
        const amount = rna * toVolume(source) * (aliquot / total);
        if (!fits(amount)) continue;
        const water = total - source + final - aliquot;
        const error = Math.abs(amount / mass - 1);
        if (!best || water < best.water ||
            (water === best.water && (source < best.source ||
            (source === best.source && error < best.error)))) {
          best = { water, source, total, aliquot, amount, error };
        }
      }
    }
    return best;
  }
  const shared = allowed.includes(transfer) ? find([transfer]) : null;
  const choice = shared || find(allowed.filter(value => value !== transfer));
  if (!choice) return hold("設定範囲で調製不可");
  return result(shared ? "shared" : "custom", choice.source, choice.total - choice.source,
    choice.aliquot, choice.amount);
}

if (typeof module !== "undefined") module.exports = { parseSamples, prepare, planSample };
