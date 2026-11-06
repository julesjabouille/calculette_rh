/* ==========================================================================
   Simulateur minimal de l'API Grist, utilisé UNIQUEMENT quand la page est
   ouverte hors de Grist (aperçu GitHub Pages / test local).
   Il rejoue les données de demo-data.js. Les colonnes « formules » ne sont
   PAS recalculées ici : c'est Grist qui fait les calculs dans la vraie vie.
   ========================================================================== */
(function () {
  const DATA = JSON.parse(JSON.stringify(window.DEMO_DATA));
  const NAMES = {
    tit: 'Simulations',
    fpt: 'SimulationsFPT',
    det: 'SimulationsDetache',
    con: 'SimulationsContractuel',
    com: 'Complements',
  };
  const LABELS = {
    tit: 'Titulaire FPE', fpt: 'FPT', det: 'Détaché', con: 'Contractuel', com: 'Compléments',
  };
  const params = new URLSearchParams(location.search);
  const typeKey = NAMES[params.get('type')] ? params.get('type') : 'tit';
  const tableId = NAMES[typeKey];

  let curId = DATA[tableId][0] ? DATA[tableId][0].id : null;
  const recordsCbs = [];
  const recordCbs = [];
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function emit() {
    const rows = clone(DATA[tableId]);
    recordsCbs.forEach((cb) => cb(rows, null));
    const cur = rows.find((r) => r.id === curId) || null;
    recordCbs.forEach((cb) => cb(cur, null));
  }

  // Bandeau de démo
  const bar = document.createElement('div');
  bar.className = 'demobar';
  bar.innerHTML = '<b>Mode démo</b> (hors Grist) – table : ';
  const sel = document.createElement('select');
  Object.keys(NAMES).forEach((k) => sel.append(new Option(LABELS[k] + ' (' + NAMES[k] + ')', k)));
  sel.value = typeKey;
  sel.onchange = () => { location.search = '?type=' + sel.value; };
  bar.append(sel);
  bar.append(document.createTextNode(' · les valeurs automatiques ne se recalculent pas ici : elles sont calculées par Grist.'));
  document.addEventListener('DOMContentLoaded', () => document.body.prepend(bar));
  if (document.readyState !== 'loading') document.body.prepend(bar);

  const table = {
    getTableId: async () => tableId,
    update: async (rec) => {
      const list = Array.isArray(rec) ? rec : [rec];
      list.forEach((r) => {
        const row = DATA[tableId].find((x) => x.id === r.id);
        if (row) Object.assign(row, r.fields);
      });
      setTimeout(emit, 120);
    },
    create: async (rec) => {
      const id = Math.max(0, ...DATA[tableId].map((r) => r.id)) + 1;
      // copie les colonnes calculées de la première ligne pour avoir un affichage cohérent
      const tpl = DATA[tableId][0] || {};
      const row = Object.assign({}, tpl, rec.fields, { id });
      DATA[tableId].push(row);
      setTimeout(emit, 120);
      return { id };
    },
    destroy: async (id) => {
      DATA[tableId] = DATA[tableId].filter((r) => r.id !== id);
      if (curId === id) curId = DATA[tableId][0] ? DATA[tableId][0].id : null;
      setTimeout(emit, 120);
    },
  };

  window.grist = {
    ready() { setTimeout(emit, 0); },
    onRecords(cb) { recordsCbs.push(cb); },
    onRecord(cb) { recordCbs.push(cb); },
    setCursorPos: async ({ rowId }) => { curId = rowId; setTimeout(emit, 0); },
    getTable: () => table,
    selectedTable: { getTableId: async () => tableId },
    docApi: {
      fetchTable: async (name) => {
        if (name === 'Baremes') {
          const rows = DATA.Baremes;
          const out = {};
          Object.keys(rows[0]).forEach((k) => { out[k] = rows.map((r) => r[k]); });
          return out;
        }
        if (name === '_grist_Tables') {
          const ids = Object.keys(NAMES).map((k, i) => i + 1);
          return { id: ids, tableId: Object.values(NAMES) };
        }
        if (name === '_grist_Tables_column') {
          const out = { id: [], parentId: [], colId: [], widgetOptions: [] };
          Object.values(NAMES).forEach((t, ti) => {
            Object.keys(DATA[t][0] || {}).forEach((c) => {
              out.id.push(out.id.length + 1);
              out.parentId.push(ti + 1);
              out.colId.push(c);
              out.widgetOptions.push('');
            });
          });
          return out;
        }
        throw new Error('Table inconnue en démo : ' + name);
      },
    },
  };
})();
