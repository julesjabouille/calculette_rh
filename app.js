/* ==========================================================================
   Fiche de paie – widget personnalisé Grist
   - Lit la ligne sélectionnée de la table (onRecord / onRecords)
   - Affiche une fiche de paie ; les champs de saisie écrivent dans Grist
   - Les champs automatiques (formules Grist) sont rafraîchis à chaque changement
   ========================================================================== */
(function () {
  'use strict';

  const OPTS = { includeColumns: 'all' };
  const TYPES = window.PAIE_TYPES;

  const S = {
    grist: null,
    type: null,          // configuration de fiche retenue
    tableId: null,
    records: [],
    curId: null,
    curRec: null,
    baremes: {},         // id -> ligne de la table Baremes
    metaChoices: {},     // colId -> [choix] lus dans Grist
    ui: null,            // { updaters, rows, ... } pour la fiche construite
    hideZero: localStorage.getItem('paie.hideZero') !== '0',
    typePromise: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /* ------------------------------------------------------------------ */
  /*  Formatage / lecture des nombres (format français)                  */
  /* ------------------------------------------------------------------ */
  const nf = (min, max) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF = { money: nf(2, 2), rate: nf(2, 4), num: nf(0, 4), int: nf(0, 0), pct: nf(2, 4), pctraw: nf(2, 2) };

  const isErr = (v) => Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const round10 = (x) => Math.round(x * 1e10) / 1e10;

  function fmtDisplay(v, fmt) {
    if (isErr(v)) return '⚠';
    if (!isNum(v)) return v == null || v === '' ? '' : String(v);
    switch (fmt) {
      case 'pct': return NF.pct.format(round10(v * 100)) + ' %';
      case 'pctraw': return NF.pctraw.format(v) + ' %';
      default: return (NF[fmt] || NF.money).format(v);
    }
  }
  // texte affiché dans un champ de saisie (hors focus)
  function fmtInput(v, fmt) {
    if (!isNum(v)) return '';
    if (fmt === 'pct') return NF.pct.format(round10(v * 100));
    return (NF[fmt] || NF.money).format(v);
  }
  // texte affiché dans un champ de saisie (en focus) : valeur brute, virgule décimale
  function fmtEdit(v, fmt) {
    if (!isNum(v)) return '';
    const x = fmt === 'pct' ? round10(v * 100) : v;
    return String(+x.toPrecision(12)).replace('.', ',');
  }
  function parseNum(s) {
    const t = String(s).replace(/[\s\u00a0\u202f€%]/g, '').replace(',', '.');
    if (t === '' || t === '-' || t === '+') return 0;
    const v = Number(t);
    return isFinite(v) ? v : NaN;
  }
  const num0 = (x) => (isNum(x) ? x : 0);

  /* ------------------------------------------------------------------ */
  /*  Lecture de la configuration Grist (table, colonnes, choix)         */
  /* ------------------------------------------------------------------ */
  async function getTableId() {
    const g = S.grist;
    try {
      if (g.selectedTable && g.selectedTable.getTableId) return await g.selectedTable.getTableId();
    } catch (e) { /* ignore */ }
    try {
      const t = g.getTable();
      if (t && t.getTableId) return await t.getTableId();
    } catch (e) { /* ignore */ }
    return null;
  }

  async function readMeta(tableId) {
    // Retourne { cols:Set, choices:{col:[…]} } à partir des tables de métadonnées de Grist
    try {
      const tables = await S.grist.docApi.fetchTable('_grist_Tables');
      const cols = await S.grist.docApi.fetchTable('_grist_Tables_column');
      const idx = tables.tableId.indexOf(tableId);
      if (idx < 0) return null;
      const tid = tables.id[idx];
      const set = new Set();
      const choices = {};
      cols.id.forEach((_, i) => {
        if (cols.parentId[i] !== tid) return;
        set.add(cols.colId[i]);
        try {
          const wo = cols.widgetOptions[i] ? JSON.parse(cols.widgetOptions[i]) : null;
          if (wo && Array.isArray(wo.choices)) choices[cols.colId[i]] = wo.choices;
        } catch (e) { /* ignore */ }
      });
      return { cols: set, choices };
    } catch (e) {
      return null;
    }
  }

  function detectType(colSet) {
    return TYPES.find((t) => t.detect(colSet)) || null;
  }

  async function ensureType(sampleRecord) {
    if (S.type) return true;
    if (!S.typePromise) {
      S.typePromise = (async () => {
        S.tableId = await getTableId();
        let cols = null;
        const meta = S.tableId ? await readMeta(S.tableId) : null;
        if (meta) { cols = meta.cols; S.metaChoices = meta.choices; }
        if (!cols && sampleRecord) cols = new Set(Object.keys(sampleRecord));
        let t = cols ? detectType(cols) : null;
        if (!t && S.tableId) t = TYPES.find((x) => x.tableNames.includes(S.tableId)) || null;
        if (!t) return false;
        S.type = t;
        buildSheet();
        return true;
      })();
    }
    const ok = await S.typePromise;
    if (!ok) S.typePromise = null; // retentera au prochain événement (ex. table vide)
    return ok;
  }

  async function loadBaremes() {
    try {
      const t = await S.grist.docApi.fetchTable('Baremes');
      const map = {};
      t.id.forEach((id, i) => {
        const row = { id };
        Object.keys(t).forEach((k) => { row[k] = t[k][i]; });
        map[id] = row;
      });
      S.baremes = map;
    } catch (e) {
      // pas d'accès complet : les taux et la liste des barèmes ne seront pas disponibles
    }
  }

  function choicesFor(key) {
    const base = (S.metaChoices && S.metaChoices[key]) ||
      ((window.PAIE_CHOICES[S.type.key] || {})[key]) || [];
    return base;
  }

  /* ------------------------------------------------------------------ */
  /*  Écriture dans Grist                                                */
  /* ------------------------------------------------------------------ */
  function setStatus(text, kind) {
    const s = $('#status');
    s.textContent = text || '';
    s.className = 'status' + (kind ? ' ' + kind : '');
    if (kind === 'ok') {
      clearTimeout(setStatus.t);
      setStatus.t = setTimeout(() => { if (s.className.includes('ok')) s.textContent = ''; }, 1800);
    }
  }

  async function commit(key, value) {
    const r = current();
    if (!r) return;
    r[key] = value; // mise à jour optimiste
    setStatus('Enregistrement…', 'busy');
    try {
      await S.grist.getTable().update({ id: r.id, fields: { [key]: value } });
      setStatus('✓ Enregistré dans Grist', 'ok');
    } catch (e) {
      setStatus('Erreur : ' + (e && e.message ? e.message : e), 'err');
    }
    refresh();
  }

  /* ------------------------------------------------------------------ */
  /*  Construction de la fiche                                           */
  /* ------------------------------------------------------------------ */
  const COLS = [
    ['label', 'Rubrique'],
    ['base', 'Base'],
    ['taux', 'Taux'],
    ['pay', 'À payer'],
    ['ded', 'À déduire'],
    ['pat', 'Charges patronales'],
  ];

  function buildSheet() {
    const T = S.type;
    const root = $('#sheet');
    root.innerHTML = '';
    const ui = { updaters: [], rows: [], inputs: [] };
    S.ui = ui;

    const fiche = el('section', 'fiche');
    $('#toolbar').hidden = false;

    // ----- en-tête
    const head = el('div', 'fiche-head');
    const title = el('div', 'fiche-title');
    title.append(el('h1', null, 'Fiche de paie'), el('span', 'badge', T.label), el('span', 'sim', 'simulation'));
    const per = el('div', 'fiche-period');
    per.append(el('label', null, 'Barème'));
    const bareCell = el('span', 'cell-inline');
    buildInput({ in: 'Bareme', fmt: 'ref' }, bareCell, ui);
    per.append(bareCell);
    head.append(title, per);
    fiche.append(head);

    // ----- situation (identité)
    const ident = el('div', 'identity');
    T.situation.forEach((f) => {
      const box = el('div', 'idbox' + (f.wide ? ' wide' : ''));
      box.append(el('label', null, f.label));
      const c = el('div', 'idval');
      buildInput(f.cell, c, ui);
      box.append(c);
      ident.append(box);
    });
    fiche.append(ident);

    // ----- tableau
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'lines');
    const thead = el('thead');
    const hr = el('tr');
    COLS.forEach(([k, name]) => hr.append(el('th', 'h-' + k, name)));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    let group = null;
    T.lines.forEach((ln) => {
      if (ln.section) {
        const tr = el('tr', 'section');
        const th = el('td', null, ln.section);
        th.colSpan = 6;
        tr.append(th);
        tbody.append(tr);
        group = { header: tr, rows: [] };
        ui.rows.push({ kind: 'section', tr, group });
        return;
      }
      const tr = el('tr', 'line' + (ln.total ? ' total' : '') + (ln.cls ? ' ' + ln.cls : '') + (ln.muted ? ' muted' : ''));
      const cells = [];
      const lab = el('td', 'c-label');
      lab.append(el('span', 'lab', ln.label));
      if (ln.hint) lab.append(el('small', 'hint', ln.hint));
      tr.append(lab);
      let hasInput = false;
      const vals = [];
      ['base', 'taux', 'pay', 'ded', 'pat'].forEach((k) => {
        const td = el('td', 'c-' + k);
        const spec = ln[k];
        if (spec) {
          const before = ui.inputs.length;
          buildCell(spec, td, ui);
          if (ui.inputs.length > before) hasInput = true;
          if (k === 'pay' || k === 'ded' || k === 'pat') {
            (Array.isArray(spec) ? spec : [spec]).forEach((s) => vals.push(s));
          }
        }
        tr.append(td);
        cells.push(td);
      });
      tbody.append(tr);
      if (ln.sub) hasInput = true;
      const rowRec = { kind: 'line', tr, hasInput, vals, total: !!ln.total, group, sub: null };
      if (group) group.rows.push(rowRec);
      ui.rows.push(rowRec);

      if (ln.sub) {
        const sr = el('tr', 'subrow');
        const td = el('td');
        td.colSpan = 6;
        const grid = el('div', 'subgrid');
        ln.sub.forEach((s) => {
          const item = el('div', 'subitem');
          item.append(el('label', null, s.label));
          const c = el('div', 'idval');
          buildInput(s, c, ui);
          item.append(c);
          grid.append(item);
        });
        td.append(grid);
        sr.append(td);
        tbody.append(sr);
        rowRec.sub = sr;
      }
    });
    table.append(tbody);
    wrap.append(table);
    fiche.append(wrap);

    // ----- synthèse annuelle
    if (T.summary && T.summary.length) {
      const sum = el('div', 'summary');
      sum.append(el('h2', null, 'Synthèse annuelle et coût complet'));
      const grid = el('div', 'sumgrid');
      T.summary.forEach((s) => {
        const card = el('div', 'card' + (s.strong ? ' strong' : ''));
        card.append(el('label', null, s.label));
        const c = el('div', 'cardval');
        buildCell(s.cell, c, ui);
        card.append(c);
        grid.append(card);
      });
      sum.append(grid);
      fiche.append(sum);
    }

    root.append(fiche);
    S.ui.fiche = fiche;
  }

  function buildCell(spec, td, ui) {
    if (Array.isArray(spec)) { spec.forEach((s) => buildCell(s, td, ui)); return; }
    if (spec.in) buildInput(spec, td, ui);
    else buildValue(spec, td, ui);
  }

  function buildValue(spec, td, ui) {
    const span = el('span', 'v');
    td.append(span);
    ui.updaters.push((r, b) => {
      const v = spec.k ? r[spec.k] : spec.f(r, b);
      span.textContent = fmtDisplay(v, spec.fmt);
      span.classList.toggle('zero', isNum(v) && Math.abs(v) < 0.005);
      span.classList.toggle('err', isErr(v));
      if (isErr(v)) span.title = 'Erreur de formule Grist : ' + v[1];
    });
  }

  function addUnit(wrapper, spec) {
    const unit = spec.fmt === 'pct' ? '%' : spec.unit;
    if (unit) wrapper.append(el('span', 'unit', unit));
  }

  function buildInput(spec, td, ui) {
    const key = spec.in;
    const fmt = spec.fmt;
    const disabledFor = (node, r) => { if (spec.enabledIf) node.disabled = !spec.enabledIf(r); };

    if (fmt === 'bool') {
      const lab = el('label', 'chk');
      const cb = el('input');
      cb.type = 'checkbox';
      lab.append(cb, el('span', null, spec.caption || ''));
      td.append(lab);
      cb.addEventListener('change', () => commit(key, cb.checked));
      ui.inputs.push(cb);
      ui.updaters.push((r) => { cb.checked = !!r[key]; disabledFor(cb, r); });
      return;
    }

    if (fmt === 'choice' || fmt === 'ref') {
      const sel = el('select', 'in');
      td.append(sel);
      sel.addEventListener('change', () => {
        commit(key, fmt === 'ref' ? Number(sel.value) : sel.value);
      });
      ui.inputs.push(sel);
      ui.updaters.push((r) => {
        let opts;
        if (fmt === 'ref') {
          opts = Object.values(S.baremes).map((b) => [String(b.id), b.Libelle || 'Barème ' + b.id]);
          if (!S.baremes[r[key]] && r[key]) opts.push([String(r[key]), 'Barème ' + r[key]]);
        } else {
          const list = choicesFor(key).slice();
          if (r[key] && !list.includes(r[key])) list.push(r[key]);
          opts = list.map((x) => [x, x]);
        }
        const sig = JSON.stringify(opts);
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          sel.innerHTML = '';
          if (!opts.length || fmt === 'choice') sel.append(new Option('—', ''));
          opts.forEach(([v, t]) => sel.append(new Option(t, v)));
        }
        if (document.activeElement !== sel) sel.value = r[key] == null ? '' : String(r[key]);
        disabledFor(sel, r);
      });
      return;
    }

    // champs texte / numériques
    const wrapper = el('span', 'field' + (fmt === 'text' ? ' text' : ''));
    const inp = el('input', 'in' + (fmt === 'text' ? '' : ' num'));
    inp.type = 'text';
    if (fmt !== 'text') inp.inputMode = 'decimal';
    inp.autocomplete = 'off';
    wrapper.append(inp);
    addUnit(wrapper, spec);
    td.append(wrapper);
    ui.inputs.push(inp);

    if (fmt !== 'text') {
      inp.addEventListener('focus', () => {
        const r = current();
        if (r) inp.value = fmtEdit(r[key], fmt);
        setTimeout(() => inp.select(), 0);
      });
    }
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'Escape') { inp.dataset.cancel = '1'; inp.blur(); }
    });
    inp.addEventListener('blur', () => {
      const r = current();
      if (!r) return;
      const cancelled = inp.dataset.cancel === '1';
      delete inp.dataset.cancel;
      if (cancelled) { paintInput(inp, r[key], fmt); return; }
      if (fmt === 'text') {
        if (inp.value !== (r[key] == null ? '' : String(r[key]))) commit(key, inp.value);
        return;
      }
      let v = parseNum(inp.value);
      if (isNaN(v)) { paintInput(inp, r[key], fmt); setStatus('Valeur numérique invalide', 'err'); return; }
      if (fmt === 'pct') v = round10(v / 100);
      if (fmt === 'int') v = Math.round(v);
      if (v !== r[key]) commit(key, v);
      else paintInput(inp, r[key], fmt);
    });
    ui.updaters.push((r) => {
      if (document.activeElement !== inp) paintInput(inp, r[key], fmt);
      disabledFor(inp, r);
    });
  }

  function paintInput(inp, v, fmt) {
    if (fmt === 'text') inp.value = v == null ? '' : String(v);
    else inp.value = fmtInput(v, fmt);
    inp.classList.toggle('zero', isNum(v) && v === 0);
  }

  /* ------------------------------------------------------------------ */
  /*  Rafraîchissement                                                    */
  /* ------------------------------------------------------------------ */
  function current() {
    if (S.curId != null) {
      const r = S.records.find((x) => x.id === S.curId);
      if (r) return r;
    }
    return S.curRec && S.curRec.id ? S.curRec : null;
  }

  function refreshSelector() {
    const sel = $('#recSelect');
    const sig = JSON.stringify(S.records.map((r) => [r.id, r.Nom]));
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = '';
      S.records.forEach((r) => sel.append(new Option(`${r.Nom || '(sans nom)'}  · #${r.id}`, r.id)));
      if (!S.records.length) sel.append(new Option('(aucune ligne)', ''));
    }
    const cur = current();
    if (cur && document.activeElement !== sel) sel.value = String(cur.id);
  }

  function refresh() {
    if (!S.type || !S.ui) return;
    document.body.classList.toggle('hide-zero', S.hideZero);
    $('#hideZero').checked = S.hideZero;
    refreshSelector();
    const r = current();
    $('#empty').hidden = !!r;
    S.ui.fiche.hidden = !r;
    if (!r) return;
    const b = S.baremes[r.Bareme] || {};
    S.ui.updaters.forEach((u) => u(r, b));

    // masquage des lignes à zéro (lignes sans champ de saisie)
    S.ui.rows.forEach((row) => {
      if (row.kind !== 'line') return;
      let zero = false;
      if (!row.hasInput && !row.total && row.vals.length) {
        zero = row.vals.every((s) => {
          const v = s.k ? r[s.k] : s.f(r, b);
          return !isNum(v) || Math.abs(v) < 0.005;
        });
      }
      row.tr.classList.toggle('is-zero', zero);
      if (row.sub) row.sub.classList.toggle('is-zero', false);
    });
    S.ui.rows.forEach((row) => {
      if (row.kind !== 'section') return;
      const anyVisible = row.group.rows.some((x) => !x.tr.classList.contains('is-zero'));
      row.tr.classList.toggle('is-zero', !anyVisible);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Actions : nouvelle ligne / dupliquer / supprimer                    */
  /* ------------------------------------------------------------------ */
  function inputSpecs() {
    const T = S.type;
    const specs = [];
    const walk = (c) => {
      if (!c) return;
      if (Array.isArray(c)) { c.forEach(walk); return; }
      if (c.in) specs.push(c);
    };
    T.situation.forEach((f) => walk(f.cell));
    T.lines.forEach((ln) => {
      ['base', 'taux', 'pay', 'ded', 'pat'].forEach((k) => walk(ln[k]));
      if (ln.sub) ln.sub.forEach(walk);
    });
    (T.summary || []).forEach((s) => walk(s.cell));
    return specs;
  }

  function defaultFor(spec) {
    const k = spec.in;
    const D = window.PAIE_NEW_DEFAULTS;
    if (S.type.defaults && k in S.type.defaults) return S.type.defaults[k];
    if (k in D) return D[k];
    switch (spec.fmt) {
      case 'bool': return false;
      case 'text': return '';
      case 'choice': return choicesFor(k)[0] || '';
      default: return 0;
    }
  }

  async function createRecord(copy) {
    const r = current();
    const fields = {};
    inputSpecs().forEach((s) => {
      if (s.in === 'Bareme') return;
      fields[s.in] = copy && r ? r[s.in] : defaultFor(s);
    });
    if (copy && r) fields.Nom = (r.Nom || '') + ' (copie)';
    const ids = Object.keys(S.baremes).map(Number);
    fields.Bareme = r && r.Bareme ? r.Bareme : ids.length ? Math.max(...ids) : 0;
    setStatus('Création…', 'busy');
    try {
      const res = await S.grist.getTable().create({ fields });
      const id = Array.isArray(res) ? res[0].id : res && res.id != null ? res.id : res;
      S.curId = id;
      if (id != null && S.grist.setCursorPos) await S.grist.setCursorPos({ rowId: id });
      setStatus('✓ Ligne créée', 'ok');
    } catch (e) {
      setStatus('Erreur : ' + (e && e.message ? e.message : e), 'err');
    }
  }

  let delArmed = null;
  async function deleteRecord() {
    const r = current();
    if (!r) return;
    const btn = $('#btnDelete');
    if (!delArmed) {
      btn.textContent = 'Confirmer ?';
      btn.classList.add('danger-armed');
      delArmed = setTimeout(resetDelete, 3000);
      return;
    }
    resetDelete();
    try {
      await S.grist.getTable().destroy(r.id);
      S.curId = null;
      setStatus('✓ Ligne supprimée', 'ok');
    } catch (e) {
      setStatus('Erreur : ' + (e && e.message ? e.message : e), 'err');
    }
  }
  function resetDelete() {
    clearTimeout(delArmed);
    delArmed = null;
    const btn = $('#btnDelete');
    btn.textContent = 'Supprimer';
    btn.classList.remove('danger-armed');
  }

  /* ------------------------------------------------------------------ */
  /*  Démarrage                                                           */
  /* ------------------------------------------------------------------ */
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Chargement impossible : ' + src));
      document.head.append(s);
    });
  }

  let loading = null;
  let reloadAgain = false;
  function reloadBaremes() {
    if (loading) { reloadAgain = true; return; }
    loading = loadBaremes().finally(() => {
      loading = null;
      refresh();
      if (reloadAgain) { reloadAgain = false; reloadBaremes(); }
    });
  }

  async function onRecords(records) {
    S.records = records || [];
    if (S.curId != null && !S.records.some((r) => r.id === S.curId)) S.curId = null;
    const ok = await ensureType(S.records[0]);
    if (!ok) { showUnknown(); return; }
    reloadBaremes();
    refresh();
  }

  async function onRecord(rec) {
    S.curRec = rec && rec.id ? rec : null;
    S.curId = rec && rec.id ? rec.id : null;
    const ok = await ensureType(rec && rec.id ? rec : null);
    if (!ok) return;
    refresh();
  }

  function showUnknown() {
    $('#sheet').innerHTML = '';
    const m = $('#empty');
    m.hidden = false;
    m.textContent = 'Table non reconnue : ce widget gère les tables Simulations, SimulationsFPT, SimulationsDetache, SimulationsContractuel et Complements.';
  }

  async function main() {
    const embedded = window.top !== window.self && !new URLSearchParams(location.search).has('demo');
    if (!embedded) {
      await loadScript('demo-data.js');
      await loadScript('mock-grist.js');
      document.body.classList.add('demo');
    }
    if (!window.grist) {
      $('#empty').hidden = false;
      $('#empty').textContent = 'API Grist indisponible (grist-plugin-api.js non chargé).';
      return;
    }
    S.grist = window.grist;

    $('#hideZero').addEventListener('change', (e) => {
      S.hideZero = e.target.checked;
      localStorage.setItem('paie.hideZero', S.hideZero ? '1' : '0');
      refresh();
    });
    $('#recSelect').addEventListener('change', (e) => {
      const id = Number(e.target.value);
      if (!id) return;
      S.curId = id;
      refresh();
      if (S.grist.setCursorPos) S.grist.setCursorPos({ rowId: id });
    });
    $('#btnNew').addEventListener('click', () => createRecord(false));
    $('#btnCopy').addEventListener('click', () => createRecord(true));
    $('#btnDelete').addEventListener('click', deleteRecord);
    $('#btnPrint').addEventListener('click', () => window.print());

    S.grist.ready({ requiredAccess: 'full', allowSelectBy: true });
    S.grist.onRecords(onRecords, OPTS);
    S.grist.onRecord(onRecord, OPTS);
  }

  main().catch((e) => {
    console.error(e);
    $('#empty').hidden = false;
    $('#empty').textContent = 'Erreur : ' + e.message;
  });
})();
