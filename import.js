/* ここから変更
 * INPUT: 通常はindex.htmlの「Excelファイルを読み込む」で選択する。
 * 列条件: Sample ID と Qubit RNA (ng/µL) を自動検出する。
 * OUTPUT: index.htmlの入力欄へ読み込み、ユーザーが修正して計算する。
 * ここまで変更 */
"use strict";

function readExcelTables(bytes) {
  const workbook = XLSX.read(bytes, { type: "array" });
  const tables = [];
  const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/μ/g, "µ").replace(/\s/g, "");
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: true });
    const offset = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
    for (let header = 0; header < rows.length; header++) {
      const headings = rows[header].map(normalize);
      const ids = headings.map((v, i) => /^(sampleid|サンプルid|試料id|id)$/.test(v) ? i : -1).filter(i => i >= 0);
      const rnas = headings.map((v, i) => /^qubitrna\(ng\/µl\)$/.test(v) ? i : -1).filter(i => i >= 0);
      const dnas = headings.map((v, i) => /^qubitdna\(ng\/µl\)$/.test(v) ? i : -1).filter(i => i >= 0);
      if (!ids.length || !rnas.length) continue;
      if (ids.length !== 1 || rnas.length !== 1 || dnas.length > 1) {
        throw new Error(name + "の見出しが重複しています。列名を確認してください。");
      }
      const [idColumn] = ids;
      const [rnaColumn] = rnas;
      const dnaColumn = dnas[0];
      const tubeColumn = headings.findIndex(value => /^(tubeno\.?|tubeid|チューブ番号)$/.test(value));
      const values = ["id\trna\tdna\ttube"];
      let missing = 0;
      for (let row = header + 1; row < rows.length; row++) {
        if (rows[row].every(v => v === null || v === "")) continue;
        if (normalize(rows[row][idColumn]) === headings[idColumn] &&
            normalize(rows[row][rnaColumn]) === headings[rnaColumn]) break;
        const id = String(rows[row][idColumn] ?? "").trim();
        const rna = rows[row][rnaColumn];
        const dna = dnaColumn === undefined ? null : rows[row][dnaColumn];
        const address = column => name + "!" + XLSX.utils.encode_cell({ r: row + offset, c: column });
        if (!id) {
          if (rna !== null && rna !== "") throw new Error(address(idColumn) + "のSample IDが空欄です。");
          continue;
        }
        if (/[\t\r\n"]/.test(id)) throw new Error(address(idColumn) + "のIDに改行・タブ・引用符があります。");
        const number = (value, column) => {
          if (value === null || value === "") return "";
          const parsed = Number(value);
          if ((typeof value !== "number" && typeof value !== "string") ||
              !Number.isFinite(parsed) || parsed < 0 || String(value).trim() === "") {
            throw new Error(address(column) + "の濃度を数値で入力してください。");
          }
          return String(Number(parsed.toPrecision(15)));
        };
        if (rna === null || rna === "") missing++;
        const tube = tubeColumn < 0 ? String(values.length) : String(rows[row][tubeColumn] ?? "").trim();
        if (!/^S?\d+$/i.test(tube)) throw new Error(address(tubeColumn) + "のTube Noを整数で入力してください。");
        values.push([id, number(rna, rnaColumn), number(dna, dnaColumn), tube].join("\t"));
      }
      if (values.length > 1) {
        tables.push({
          text: values.join("\n"), label: name + " · 見出し " + (header + offset + 1) + "行目",
          description: (values.length - 1) + "件 · Sample ID " + XLSX.utils.encode_col(idColumn) +
            "列 / Qubit RNA " + XLSX.utils.encode_col(rnaColumn) + "列 · RNA空欄 " + missing + "件"
        });
      }
    }
  }
  if (!tables.length) throw new Error("Sample ID と Qubit RNA (ng/µL) の見出しがある表を確認してください。");
  return tables;
}
if (typeof module !== "undefined") module.exports = { readExcelTables };
