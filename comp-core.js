// 成分アプリの共通ロジック（CSV解析・材質の照合・判定）。画面（index.html）と検証の両方で使う
(function (root) {
  "use strict";
  const EL = ["C", "Si", "Mn", "P", "S", "Cu", "Ni", "Cr", "Mo", "Ti", "V", "Al", "Sn", "CE", "Fe1", "Fe2"];
  const POUR_FROM = 261027;   // 注湯日報（2号機の枝番）の運用開始。それ以前の注湯Noは昼夜表記のため照合しない
  const pad2 = n => String(n).padStart(2, "0");

  function lotOf(y, m, d) { return (y % 100) * 10000 + m * 100 + d; }
  function lotDate(lot) { return "20" + pad2(Math.floor(lot / 10000)) + "-" + pad2(Math.floor(lot / 100) % 100) + "-" + pad2(lot % 100); }

  // 試料名： "(11)/(3 )(2-1                  )" "(11)/(3 )(9 大内x2  )" "(11)/(4 )(2" "(11)/(3 )(17 その他 L )"
  function parseName(name) {
    const m = /^\s*\(\s*(\d+)\s*\)\s*\/\s*\(\s*(\d+)\s*\)\s*\((.*?)\)?\s*$/.exec(String(name || ""));
    if (!m) return null;
    const inner = m[3].trim();
    const t = /^(\d+(?:-\d+)?)(.*)$/.exec(inner);
    if (!t) return null;
    return { month: +m[1], day: +m[2], tp: t[1], comment: t[2].trim(), kind: t[1].indexOf("-") >= 0 ? "注湯" : "溶解" };
  }

  // 値： "3.46H" → {v:3.46, f:"H"}
  function numOf(s) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*([HLhl]?)\s*$/.exec(String(s == null ? "" : s));
    if (!m) return { v: null, f: "" };
    return { v: parseFloat(m[1]), f: m[2].toUpperCase() };
  }

  // CSV（測定器）を解析。形式A：先頭2列が空・試料名は3列目・日付と時刻あり。形式B：試料名は先頭列・日付時刻なし
  function parseCsv(text, opt) {
    const year = (opt && opt.year) || 2026;
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    const head = lines[0].split(",").map(h => h.trim());
    const fmt = head.indexOf("Fe1") >= 0 ? "A" : "B";
    const colOf = {};
    head.forEach((h, i) => { const k = h === "A" ? "Al" : h; if (EL.indexOf(k) >= 0) colOf[k] = i; });
    const nameCol = fmt === "A" ? 2 : 0;
    const out = [], errors = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      if (!lines[i].trim()) continue;
      const p = parseName(c[nameCol]);
      if (!p) { if (c[nameCol] && c[nameCol].trim()) errors.push({ line: i + 1, name: c[nameCol], reason: "試料名を読めません" }); continue; }
      const el = {}, hl = {};
      let any = false;
      Object.keys(colOf).forEach(k => {
        const n = numOf(c[colOf[k]]);
        if (n.v !== null) { el[k] = n.v; any = true; }
        if (n.f) hl[k] = n.f;
      });
      if (!any) continue;
      let date = "", mtime = "";
      if (fmt === "A") {
        const dm = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(c[3] || "");
        if (dm) date = dm[1] + "-" + pad2(dm[2]) + "-" + pad2(dm[3]);
        mtime = (c[4] || "").trim();   // 測定時刻（同じ試料名の重複の判定に使う。表示用の時刻は日報の時刻）
      }
      // ロットは試料名の日付（(11)/(N ) の N）で決める。測定日とはずれることがある（例：11/03 ロットを 11/04 に測定）
      const lot = lotOf(date ? +date.slice(0, 4) : year, p.month, p.day);
      out.push({ line: i + 1, name: String(c[nameCol]).trim(), lot: lot, kind: p.kind, tp: p.tp, comment: p.comment,
                 mtime: mtime, date: date, el: el, hl: hl, src: fmt === "A" ? "形式A" : "形式B" });
    }
    return { format: fmt, rows: out, errors: errors };
  }

  // 材質・時刻の照合：溶解（溶解TP）は溶炉No、注湯（注湯TP）は2号機のチャージNo
  // 時刻は日報の時刻（溶解＝出湯時刻、注湯＝そのチャージの初回の時刻）
  function planFor(lot, kind, tp, plan) {
    const none = { mat: "", src: "", time: "" };
    if (!plan) return none;
    if (kind === "溶解") {
      const e = plan.melt && plan.melt[lot] && plan.melt[lot][tp];
      return e ? { mat: e.mat || "", src: e.mat ? "溶解日報" : "", time: e.time || "" } : none;
    }
    if (lot < POUR_FROM) return none;
    const parts = tp.split("-");
    if (parts[0] !== "2") return none;
    const e = plan.pour && plan.pour[lot] && plan.pour[lot][String(+parts[1])];
    return e ? { mat: e.mat || "", src: e.mat ? "注湯日報" : "", time: e.time || "" } : none;
  }

  // 狙い値：生産日以前で最も新しい版
  function aimFor(lot, mat, M) {
    const d = lotDate(lot);
    let hit = null;
    (M.aim || []).forEach(a => { if (a.date <= d) hit = a; });
    return hit && hit.rec[mat] ? hit.rec[mat] : null;
  }

  function specFor(mat, M) { return (M.spec || []).find(s => s.mat === mat) || null; }

  // 判定（溶解・注湯とも全元素）
  //  C・Si：溶解は狙い値、注湯は注湯規格（材質ごと）
  //  Mn：注湯規格（材質ごと）
  //  P・S・Cu・Cr・Sn：材質共通の規格（master.js の common）
  //  溶解の Mn・S は下限割れをNGにしない（出湯後に変化する添加剤のため）。上限超えはNG
  function judge(r, M) {
    const res = { judge: "", ng: [], att: [] };
    if (!Object.keys(r.el).length) return res;
    if (!r.mat) { res.judge = "材質未入力"; return res; }
    const sp = specFor(r.mat, M);
    if (!sp) { res.judge = "規格なし"; return res; }
    const CO = M.common || {};
    const lim = {};
    if (sp.Mn) lim.Mn = { lo: sp.Mn[0], hi: sp.Mn[1] };
    if (CO.P) lim.P = { lo: CO.P[0], hi: CO.P[1] };
    if (sp.S) lim.S = { lo: sp.S[0], hi: sp.S[1] };          // 材質ごとの S（1204）
    else if (CO.S) lim.S = { lo: CO.S[0], hi: CO.S[1] };      // 共通の S
    if (r.kind === "溶解") {
      const a = aimFor(r.lot, r.mat, M);
      if (a && a.C) lim.C = { lo: a.C[0], hi: a.C[1] };
      if (a && a.Si) lim.Si = { lo: a.Si[0], hi: a.Si[1] };
    } else {
      if (sp.C) lim.C = { lo: sp.C[0], hi: sp.C[1] };
      if (sp.Si) lim.Si = { lo: sp.Si[0], hi: sp.Si[1] };
    }
    const hasLim = Object.keys(lim).some(k => lim[k] && (lim[k].lo != null || lim[k].hi != null));
    const hasCau = ["Cu注", "Sn注", "Cr注", "Cr上"].some(k => CO[k] !== undefined);
    if (!hasLim && !hasCau) { res.judge = "規格未登録"; return res; }
    const v = r.el;
    Object.keys(lim).forEach(k => {
      const x = v[k]; const L = lim[k];
      if (x == null || !L) return;
      const softLo = r.kind === "溶解" && (k === "Mn" || k === "S");
      if (L.lo != null && x < L.lo && !softLo) res.ng.push(k + "低");
      if (L.hi != null && x > L.hi) res.ng.push(k + "高");
    });
    // Cr：0.07 以上は NG、0.06 以上 0.07 未満は注意
    if (v.Cr != null && CO["Cr上"] !== undefined && v.Cr >= CO["Cr上"]) res.ng.push("Cr高");
    else if (v.Cr != null && CO["Cr注"] !== undefined && v.Cr >= CO["Cr注"]) res.att.push("注Cr");
    // Cu・Sn：注意域
    if (v.Cu != null && CO["Cu注"] !== undefined && v.Cu >= CO["Cu注"]) res.att.push("注Cu");
    if (v.Sn != null && CO["Sn注"] !== undefined && v.Sn >= CO["Sn注"]) res.att.push("注Sn");
    res.judge = res.ng.length ? "NG" : res.att.length ? "注意" : "OK";
    return res;
  }

  function sampleId(r) {
    return r.lot + "-" + (r.kind === "注湯" ? "R" : "B") + "-" + r.tp + (r.mtime ? "-" + r.mtime.replace(/:/g, "") : "");
  }

  // CSVの行から、画面・保存に使う記録を作る
  function buildRecords(parsed, plan, M, opt) {
    const recs = parsed.rows.map(row => {
      const pl = planFor(row.lot, row.kind, row.tp, plan);
      const r = { id: sampleId(row), lot: row.lot, name: row.name, kind: row.kind, tp: row.tp, time: pl.time, mtime: row.mtime,
                  mat: pl.mat, matSrc: pl.src, el: row.el, hl: row.hl, comment: row.comment, src: row.src,
                  note: "", judge: "", ng: [], att: [] };
      const j = judge(r, M); r.judge = j.judge; r.ng = j.ng; r.att = j.att;
      r.note = checkNote(r);
      return r;
    });
    // 同じロット・同じTPの重複：後の測定を採用し、前の測定は参考扱い
    const groups = {};
    recs.forEach(r => { const k = r.lot + "|" + r.tp; (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      if (g.length < 2) return;
      g.sort((a, b) => (a.mtime || "").localeCompare(b.mtime || ""));
      g.forEach((r, i) => { if (i < g.length - 1) { r.judge = "重複（参考）"; r.ng = []; r.att = []; r.note = "同じ試料名の後の測定を採用"; } else { r.note = (r.note ? r.note + "／" : "") + "同じ試料名が " + g.length + " 件（この測定を採用）"; } });
    });
    return recs;
  }

  function checkNote(r) {
    const notes = [];
    const m = /その他\s*([HL])/.exec(r.comment || "");
    if (m) {
      const cm = "その他" + m[1];
      if (r.mat && r.mat !== cm) notes.push("コメント「" + cm + "」と材質「" + r.mat + "」が違う");
    }
    if (/その他/.test(r.comment || "") && !m && r.mat && !/^その他[HL]$|^その他SiL$/.test(r.mat)) notes.push("コメントは「その他」だが材質は「" + r.mat + "」");
    if (!r.mat && r.kind === "溶解") notes.push("溶解日報に材質がありません");
    if (!r.mat && r.kind === "注湯") notes.push("注湯日報に材質がありません（2号機の枝番のみ照合）");
    return notes.join("／");
  }

  const api = { EL, POUR_FROM, lotOf, lotDate, parseName, numOf, parseCsv, planFor, aimFor, judge, sampleId, buildRecords, checkNote };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CompCore = api;
})(typeof window !== "undefined" ? window : globalThis);
