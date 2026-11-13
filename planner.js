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
const UNITS = 1000;

function prepare(settings) {
  const { volume, mass, transfer, reserve, tolerance, minimum } = settings;
  if (!Object.values(settings).every(Number.isFinite) || mass <= 0 || volume <= 0 ||
      minimum <= 0 || transfer < minimum || transfer > volume || reserve < 0 || tolerance < 0 || tolerance >= 100) {
    throw new Error("調製条件を確認してください。共通移送量は最終体積以下で指定します。");
  }
  const ticks = value => {
    const scaled = value * UNITS;
    const rounded = Math.round(scaled);
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > EPS) {
      throw new Error("体積の設定は小数点以下3桁まで入力できます。");
    }
    return rounded;
  };
  const pipettes = new Map([[0, ""]]);
  for (const name of ["P2", "P10", "P20", "P200"]) {
    const min = ticks(settings[name + "Min"]);
    const max = ticks(settings[name + "Max"]);
    const step = ticks(settings[name + "Step"]);
    if (min <= 0 || max < min || step <= 0 || min % step || max % step || (max - min) / step > 2000) {
      throw new Error(name + "の最小・最大は刻みの倍数で、設定段階は2,001以下にしてください。");
    }
    for (let value = min; value <= max; value += step) {
      if (!pipettes.has(value)) pipettes.set(value, name);
    }
  }
  const floor = ticks(minimum);
  for (const value of pipettes.keys()) {
    if (value > 0 && value < floor) pipettes.delete(value);
  }
  const common = ticks(transfer);
  if (!pipettes.has(common)) throw new Error("共通移送量をピペットで設定できる値にしてください。");
  const volumes = [...pipettes.keys()].filter(Boolean).sort((a, b) => a - b);
  const final = ticks(volume);
  return {
    final, mass, transfer: common, reserve: ticks(reserve), tolerance: tolerance / 100,
    pipettes, volumes, aliquots: volumes.filter(value => value <= final && pipettes.has(final - value))
  };
}

function firstAtLeast(values, threshold) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < threshold) low = mid + 1;
    else high = mid;
  }
  return values[low];
}

function planSample(sample, grid) {
  const { rna, stock } = sample;
  const { final, transfer, reserve, mass, tolerance, pipettes, volumes, aliquots } = grid;
  const hold = reason => ({ ...sample, kind: "hold", reason });
  if (rna === null || rna === 0) return hold("RNA濃度を確認");
  const ratio = rna / UNITS / mass;
  if (ratio * final < 1 - tolerance - EPS) return hold("最終体積内でRNA量が不足");
  if (stock !== null && rna * stock / mass < 1 - tolerance - EPS) return hold("原液残量が不足");

  const stockMax = stock === null ? Infinity : stock * UNITS + EPS;
  if (stockMax < volumes[0]) return hold("原液残量が最小分注量未満");
  const fits = relative => Math.abs(relative - 1) <= tolerance + EPS;
  const result = (kind, source, water, aliquot, relative) => ({
    ...sample, kind, source: source / UNITS, intermediateWater: water / UNITS,
    aliquot: aliquot / UNITS, finalWater: (final - aliquot) / UNITS,
    waste: kind === "direct" ? 0 : (source + water - aliquot) / UNITS,
    amount: relative * mass, error: (relative - 1) * 100,
    sourcePipette: pipettes.get(source), intermediateWaterPipette: pipettes.get(water),
    aliquotPipette: pipettes.get(aliquot), finalWaterPipette: pipettes.get(final - aliquot)
  });

  let direct;
  for (const aliquot of aliquots) {
    if (aliquot > stockMax) break;
    const relative = ratio * aliquot;
    if (fits(relative) && (!direct || Math.abs(relative - 1) < Math.abs(direct.error) / 100)) {
      direct = result("direct", aliquot, 0, aliquot, relative);
    }
  }
  if (direct) return direct;

  // 各原液量に対し、必要量以上の水を設定できる最小の分注量を探す。
  function find(transfers) {
    let best;
    const maxWater = volumes[volumes.length - 1];
    for (const aliquot of transfers) {
      for (const source of volumes) {
        if (source > stockMax) break;
        const minimumWater = source * (aliquot * ratio / (1 + tolerance + EPS) - 1);
        if (minimumWater > maxWater) break;
        const water = firstAtLeast(volumes, Math.max(aliquot + reserve - source, minimumWater));
        if (water === undefined) continue;
        const relative = ratio * source * (aliquot / (source + water));
        if (!fits(relative)) continue;
        const totalWater = water + final - aliquot;
        const error = Math.abs(relative - 1);
        if (!best || totalWater < best.totalWater ||
            (totalWater === best.totalWater && (source < best.source ||
            (source === best.source && error < best.error)))) {
          best = { totalWater, source, water, aliquot, relative, error };
        }
      }
    }
    return best;
  }
  const shared = aliquots.includes(transfer) ? find([transfer]) : null;
  const choice = shared || find(aliquots.filter(value => value !== transfer));
  let serial;
  // 原液は最小分注量、A→B と B→最終は共通移送量に揃える。
  const source = volumes[0];
  if (aliquots.includes(transfer) && source <= stockMax) {
    for (const firstWater of volumes) {
      const firstTotal = source + firstWater;
      if (firstTotal < transfer + reserve) continue;
      const waterSoFar = firstWater + final - transfer;
      if (waterSoFar + volumes[0] >= (serial?.totalWater ?? choice?.totalWater ?? Infinity)) break;
      const firstRatio = ratio * (source / firstTotal);
      const minimumWater = transfer * (transfer * firstRatio / (1 + tolerance + EPS) - 1);
      const secondWater = firstAtLeast(volumes, Math.max(reserve, minimumWater));
      if (secondWater === undefined) continue;
      const relative = firstRatio * transfer * (transfer / (transfer + secondWater));
      const totalWater = waterSoFar + secondWater;
      if (fits(relative) && totalWater < (serial?.totalWater ?? choice?.totalWater ?? Infinity)) {
        serial = { firstWater, secondWater, relative, totalWater };
      }
    }
  }
  if (serial) {
    const plan = result("serial", source, serial.firstWater, transfer, serial.relative);
    return {
      ...plan, secondSource: transfer / UNITS, secondSourcePipette: pipettes.get(transfer),
      secondWater: serial.secondWater / UNITS, secondWaterPipette: pipettes.get(serial.secondWater),
      waste: (source + serial.firstWater - transfer + serial.secondWater) / UNITS
    };
  }
  if (!choice) return hold("設定したピペットで調製不可");
  return result(shared ? "shared" : "custom", choice.source, choice.water, choice.aliquot, choice.relative);
}

if (typeof module !== "undefined") module.exports = { parseSamples, prepare, planSample };
