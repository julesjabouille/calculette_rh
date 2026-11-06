/* ==========================================================================
   Description des fiches de paie : une configuration par table Grist.

   Chaque ligne de la fiche peut afficher 5 cellules :
     base | taux | pay (à payer) | ded (à déduire) | pat (charges patronales)

   Une cellule est :
     K('Col')            -> valeur AUTOMATIQUE lue dans la colonne formule Grist
     Fn((r,b)=>…)        -> valeur d'affichage calculée à partir de la ligne r et du barème b
     I('Col', fmt, opt)  -> champ SAISISSABLE : écrit dans la colonne Grist (bidirectionnel)

   Les montants affichés pour les colonnes automatiques viennent TOUJOURS de Grist
   (aucune formule de paie n'est recalculée ici, Grist reste la source de vérité).
   ========================================================================== */

(function () {
  // ---- constructeurs de cellules ----------------------------------------
  const K = (k, fmt = 'money') => ({ k, fmt });
  const Fn = (f, fmt = 'money') => ({ f, fmt });
  const I = (k, fmt = 'money', o = {}) => ({ in: k, fmt, ...o });
  const Bt = (key, fmt = 'pct') => Fn((r, b) => b[key], fmt); // taux issu du barème

  const L = (label, o = {}) => ({ label, ...o });
  const SEC = (title) => ({ section: title });
  const TOT = (label, o = {}) => ({ total: true, label, ...o });

  const n = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  const eur = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // assiette mensuelle = points × valeur du point × quotité
  const assiette = (pts) => (r) =>
    'Assiette : ' + eur.format(n(pts(r)) * n(r.ValeurPoint) * n(r.Quotite)) + ' € (points × valeur du point × quotité)';

  // ---- éléments communs ----------------------------------------------------
  const IHTS_SUB = [
    I('Ihts1', 'num', { label: 'Jour ≤ 14 h' }),
    I('Ihts2', 'num', { label: 'Jour > 14 h' }),
    I('Ihts3', 'num', { label: 'Nuit ≤ 14 h' }),
    I('Ihts4', 'num', { label: 'Nuit > 14 h' }),
    I('Ihts5', 'num', { label: 'Dim./férié ≤ 14 h' }),
    I('Ihts6', 'num', { label: 'Dim./férié > 14 h' }),
  ];

  const ligneBrut = L('Indice majoré', {
    hint: 'indice × valeur du point × quotité',
    base: I('IndiceRem', 'int', { unit: 'pts' }),
    taux: Fn((r) => r.ValeurPoint, 'rate'),
    pay: K('Brut'),
  });
  const ligneNbi = L('Nouvelle bonification indiciaire (NBI)', {
    base: I('NbiPoints', 'int', { unit: 'pts' }),
    taux: Fn((r) => r.ValeurPoint, 'rate'),
    pay: K('Nbi'),
  });
  const ligneResidence = L('Indemnité de résidence', {
    base: Fn((r, b) => Math.max(n(r.IndiceRem), n(b.IndicePlancherIR)) * n(r.ValeurPoint) * n(r.Quotite)),
    taux: Bt('TauxResidence'),
    pay: K('Residence'),
  });
  const ligneResidenceNbi = (tauxKey) =>
    L('Indemnité de résidence sur NBI', {
      base: Fn((r) => n(r.NbiPoints) * n(r.ValeurPoint) * n(r.Quotite)),
      taux: Bt(tauxKey),
      pay: K('ResidenceNbi'),
    });
  const ligneSft = L('Supplément familial de traitement (SFT)', {
    base: I('NbEnfants', 'int', { unit: 'enf.' }),
    pay: K('Sft'),
  });
  const ligneTransfert = L('Transfert primes / points', {
    hint: 'abattement selon la catégorie',
    base: I('CatTransfert', 'choice'),
    pay: K('TransfertPrimes'),
  });
  const lignePsc = L('Participation protection sociale complémentaire', {
    base: I('Psc', 'bool', { caption: 'PSC' }),
    pay: K('Psc15'),
  });
  const ligneCarteOrange = L('Remboursement transport (carte orange)', { pay: I('CarteOrange') });
  const ligneIndDefisc = L('Indemnité défiscalisée', { pay: I('IndDefisc') });
  const ligneIhts = L('Heures supplémentaires (IHTS)', {
    hint: 'saisir le nombre d’heures par tranche',
    pay: K('Ihts'),
    sub: IHTS_SUB,
  });
  const ligneInterventions = L('Interventions (astreintes)', {
    base: I('HeuresInterv', 'num', { unit: 'h' }),
    taux: Bt('TauxIntervention', 'rate'),
    pay: K('Interventions'),
  });
  const ligneIcCsg = L('Indemnité compensatrice de CSG', {
    hint: 'cocher « montant connu » pour saisir le montant',
    base: [
      I('IcCsgConnue', 'bool', { caption: 'montant connu' }),
      I('IcCsgMontant', 'money', { enabledIf: (r) => !!r.IcCsgConnue }),
    ],
    pay: K('IcCsg'),
  });
  const ligneAvantageNature = (inPay) =>
    L('Avantage en nature', inPay ? { pay: I('AvantageNature') } : { base: I('AvantageNature'), info: true });

  // ---- cotisations salariales communes -------------------------------------
  const csgLines = (assietteKey = 'AssietteCsg') => [
    L('CSG non déductible', { base: K(assietteKey), taux: Bt('CsgNonDed'), ded: K('CsgNonDed') }),
    L('CSG déductible', { base: K(assietteKey), taux: Bt('CsgDed'), ded: K('CsgDed') }),
    L('CRDS', { base: K(assietteKey), taux: Bt('Crds'), ded: K('Crds') }),
  ];
  const ligneReduc = L('Réduction cotisation heures supplémentaires', { ded: K('ReductionHeuresSup') });
  const ligneRegul = L('Régularisation', { ded: I('Regul') });
  const ligneMutuelle = L('Mutuelle', { ded: I('Mutuelle') });
  const lignePrefon = L('Préfon', { ded: I('Prefon') });

  const pasLine = L('Prélèvement à la source (PAS)', {
    hint: 'base = net imposable',
    base: K('Imposable'),
    taux: I('TauxPAS', 'pct'),
    ded: K('Pas'),
  });

  const netRows = [
    TOT('TOTAL À PAYER', { pay: K('TotalAPayer') }),
    TOT('TOTAL À DÉDUIRE', { ded: K('TotalADeduire') }),
    TOT('NET AVANT PRÉLÈVEMENT À LA SOURCE', { pay: K('NetAvantPAS'), cls: 'net1' }),
    pasLine,
    TOT('NET À PAYER APRÈS PAS', { pay: K('NetApresPAS'), cls: 'net2' }),
  ];

  // Ordre des lignes : gains, retenues, totaux, part patronale
  const patTail = (extra = []) => [
    TOT('TOTAL CHARGES PATRONALES', { pat: K('TotalPatronal') }),
    TOT('COÛT EMPLOYEUR MENSUEL', { pat: K('CoutEmployeur'), cls: 'cost' }),
    L('Coût employeur / total à payer', { pat: K('CoutEmployeurPct', 'pctraw'), muted: true }),
    ...extra,
  ];

  // ---- cotisations patronales fonctionnaires --------------------------------
  const fonctionnairePat = (o) => [
    SEC('Part patronale'),
    L('FNH', { base: Fn((r, b) => Math.min(n(r.BrutNbi), n(b.PlafondSS))), taux: Bt('PatFnh'), pat: K('PatFnh') }),
    L('Allocations familiales (CAF)', {
      base: K('BrutNbi'), taux: Fn((r, b) => (r.Mil1an ? 0 : b.PatCaf), 'pct'), pat: K('PatCaf'),
    }),
    L('FNAL', { base: K('BrutNbi'), taux: Fn((r, b) => (r.Mil1an ? 0 : b.PatFnal), 'pct'), pat: K('PatFnal') }),
    L('Contribution solidarité autonomie (CSA)', {
      base: K('BrutNbi'), taux: Fn((r, b) => (r.Mil1an ? 0 : b.PatCsa), 'pct'), pat: K('PatCsa'),
    }),
    L('Maladie', { base: K('BrutNbi'), taux: Fn((r, b) => (r.Mil1an ? 0 : b.PatMaladie), 'pct'), pat: K('PatMaladie') }),
    L('Forfait social (PSC)', { base: K('Psc15'), taux: Bt('ForfaitSocial'), pat: K('PatForfaitSocial') }),
    ...o.retraite,
    L('RAFP', {
      base: K('RafpBase'), taux: Fn((r, b) => (o.rafpNul && o.rafpNul(r) ? 0 : b.Rafp), 'pct'), pat: K('PatRafp'),
    }),
    L('Versement mobilité (transport)', { base: K('BrutNbi'), taux: Bt('PatTransport'), pat: K('PatTransport') }),
    ...patTail(),
  ];

  const pcPat = (milStatut) => [
    L('Contribution pension civile', {
      base: Fn((r) => n(r.IndicePC) * n(r.ValeurPoint) * n(r.Quotite)),
      taux: Fn((r, b) => (r.Statut === milStatut ? b.PatPensionCivileMil : b.PatPensionCivile), 'pct'),
      pat: K('PatPensionCivile'),
    }),
    L('Contribution pension civile sur NBI', {
      base: Fn((r) => n(r.NbiPoints) * n(r.ValeurPoint) * n(r.Quotite)),
      taux: Fn((r, b) => (r.Statut === milStatut ? b.PatPensionCivileMil : b.PatPensionCivile), 'pct'),
      pat: K('PatPensionCivileNbi'),
    }),
    L('Allocation temporaire d’invalidité (ATI)', {
      base: Fn((r) => (n(r.IndicePC) + n(r.NbiPoints)) * n(r.ValeurPoint) * n(r.Quotite)),
      taux: Fn((r, b) => (r.Statut === milStatut ? 0 : b.PatAti), 'pct'),
      pat: K('PatAti'),
    }),
  ];

  const pcDeductions = [
    L('Pension civile', {
      hint: assiette((r) => r.IndicePC),
      base: I('IndicePC', 'int', { unit: 'pts' }),
      taux: Bt('PensionCivileSal'), ded: K('PensionCivile'),
    }),
    L('Pension civile sur NBI', {
      hint: assiette((r) => r.NbiPoints),
      base: Fn((r) => r.NbiPoints, 'int'),
      taux: Bt('PensionCivileSal'), ded: K('PensionCivileNbi'),
    }),
    L('Pension civile sur IMT', { hint: 'Assiette : montant de l’IMT', base: K('Imt'), taux: Bt('TauxPcImt'), ded: K('PensionCivileImt') }),
  ];

  const lignesImt = (montantKey) => L('Indemnité mensuelle de technicité (IMT)', {
    base: I('ImtOui', 'bool', { caption: 'IMT' }),
    taux: Fn((r, b) => b[montantKey], 'rate'),
    pay: K('Imt'),
  });

  const summaryPension = [
    { label: 'Régime indemnitaire annuel', cell: K('RegimeIndemnitaireAnnuel') },
    { label: 'Total brut annuel', cell: K('TotalBrutAnnuel') },
    { label: 'Charges employeur annuelles', cell: K('ChargeEmployeurAnnuelle') },
    { label: 'dont hors pension', cell: K('ChargeHorsPension') },
    { label: 'dont pension + ATI', cell: K('ChargePensionAti') },
    { label: 'Coût complet année pleine', cell: K('CoutCompletAnneePleine'), strong: true },
    { label: 'Jours (proratisation)', cell: I('Jours', 'int', { unit: 'j' }) },
    { label: 'Coût proratisé', cell: K('CoutProratise'), strong: true },
  ];

  // ==========================================================================
  //  1. TITULAIRE FPE  (table "Simulations")
  // ==========================================================================
  const TIT = {
    key: 'tit',
    label: 'Titulaire FPE',
    tableNames: ['Simulations'],
    detect: (c) => c.has('Prime3') && c.has('PensionCivile'),
    situation: [
      { cell: I('Nom', 'text'), label: 'Nom', wide: true },
      { cell: I('Statut', 'choice'), label: 'Statut' },
      { cell: I('Quotite', 'num'), label: 'Quotité' },
      { cell: I('Mil1an', 'bool', { caption: 'Mil1an' }), label: 'Option' },
    ],
    lines: [
      SEC('Rémunération'),
      ligneBrut, ligneNbi, ligneResidence, ligneResidenceNbi('TauxResidence'), ligneSft,
      lignesImt('ImtMontant'), ligneTransfert, ligneIcCsg,
      L('IFSE', { pay: I('Ifse') }),
      L('ISP', { pay: I('Isp') }),
      L('Prime 3', { pay: I('Prime3') }),
      L('Prime 4', { pay: I('Prime4') }),
      L('Indemnité dégressive', { pay: I('Degressive') }),
      lignePsc, ligneCarteOrange, ligneIndDefisc, ligneIhts, ligneInterventions,
      SEC('Éléments informatifs'),
      ligneAvantageNature(false),
      SEC('Retenues'),
      ...pcDeductions,
      ...csgLines(),
      ligneReduc,
      L('RAFP', { base: K('RafpBase'), taux: Bt('Rafp'), ded: K('RafpSal') }),
      ligneRegul, ligneMutuelle, lignePrefon,
      SEC('Totaux'),
      ...netRows,
      ...fonctionnairePat({ retraite: pcPat('M1') }),
    ],
    summary: summaryPension,
    defaults: { Statut: '1' },
  };

  // ==========================================================================
  //  2. FONCTION PUBLIQUE TERRITORIALE  (table "SimulationsFPT")
  // ==========================================================================
  const FPT = {
    key: 'fpt',
    label: 'Fonction publique territoriale (FPT)',
    tableNames: ['SimulationsFPT'],
    detect: (c) => c.has('Prime28') && c.has('Cnracl'),
    situation: [
      { cell: I('Nom', 'text'), label: 'Nom', wide: true },
      { cell: I('Statut', 'choice'), label: 'Statut' },
      { cell: I('Quotite', 'num'), label: 'Quotité' },
      { cell: I('Mil1an', 'bool', { caption: 'Mil1an' }), label: 'Option' },
    ],
    lines: [
      SEC('Rémunération'),
      ligneBrut, ligneNbi, ligneResidence, ligneResidenceNbi('TauxResidence'), ligneSft,
      ligneTransfert, ligneIcCsg,
      L('Prime', { pay: I('Prime') }),
      L('ISP', { pay: I('Isp') }),
      L('Prime 28', { pay: I('Prime28') }),
      L('Prime 29', { pay: I('Prime29') }),
      L('Prime 30', { pay: I('Prime30') }),
      lignePsc, ligneCarteOrange, ligneIndDefisc, ligneIhts, ligneInterventions,
      SEC('Éléments informatifs'),
      ligneAvantageNature(false),
      SEC('Retenues'),
      L('CNRACL', {
        hint: assiette((r) => r.IndicePC),
        base: I('IndicePC', 'int', { unit: 'pts' }),
        taux: Fn((r, b) => (r.Statut === '4' ? 0 : b.CnraclSal), 'pct'), ded: K('Cnracl'),
      }),
      L('CNRACL sur NBI', {
        hint: assiette((r) => r.NbiPoints),
        base: Fn((r) => r.NbiPoints, 'int'),
        taux: Fn((r, b) => (r.Statut === '4' ? 0 : b.CnraclSal), 'pct'), ded: K('CnraclNbi'),
      }),
      ...csgLines(),
      ligneReduc,
      L('RAFP', { base: K('RafpBase'), taux: Bt('Rafp'), ded: K('RafpSal') }),
      ligneRegul, ligneMutuelle, lignePrefon,
      SEC('Totaux'),
      ...netRows,
      ...fonctionnairePat({
        retraite: [
          L('CNRACL', {
            base: Fn((r) => n(r.IndicePC) * n(r.ValeurPoint) * n(r.Quotite)), taux: Bt('PatCnracl'), pat: K('PatCnracl'),
          }),
          L('CNRACL sur NBI', {
            base: Fn((r) => n(r.NbiPoints) * n(r.ValeurPoint) * n(r.Quotite)), taux: Bt('PatCnracl'), pat: K('PatCnraclNbi'),
          }),
          L('ATI collectivités locales', {
            base: Fn((r) => n(r.IndicePC) * n(r.ValeurPoint) * n(r.Quotite)), taux: Bt('PatAtiAcl'), pat: K('PatAtiAcl'),
          }),
        ],
      }),
    ],
    summary: [
      { label: 'Régime indemnitaire annuel', cell: K('RegimeIndemnitaireAnnuel') },
      { label: 'Total brut annuel', cell: K('TotalBrutAnnuel') },
      { label: 'Charges employeur annuelles', cell: K('ChargeEmployeurAnnuelle') },
      { label: 'dont hors CNRACL', cell: K('ChargeHorsCnracl') },
      { label: 'dont CNRACL + ATI', cell: K('ChargeCnraclAti') },
      { label: 'Coût complet année pleine', cell: K('CoutCompletAnneePleine'), strong: true },
      { label: 'Jours (proratisation)', cell: I('Jours', 'int', { unit: 'j' }) },
      { label: 'Coût proratisé', cell: K('CoutProratise'), strong: true },
    ],
    defaults: { Statut: '4' },
  };

  // ==========================================================================
  //  3. DÉTACHÉ  (table "SimulationsDetache")
  // ==========================================================================
  const DET = {
    key: 'det',
    label: 'Fonctionnaire détaché',
    tableNames: ['SimulationsDetache'],
    detect: (c) => c.has('Parlementaire'),
    situation: [
      { cell: I('Nom', 'text'), label: 'Nom', wide: true },
      { cell: I('Statut', 'choice'), label: 'Statut' },
      { cell: I('Quotite', 'num'), label: 'Quotité' },
      { cell: I('Mil1an', 'bool', { caption: 'Mil1an' }), label: 'Option' },
      { cell: I('Parlementaire', 'bool', { caption: 'Parlementaire' }), label: 'Option' },
    ],
    lines: [
      SEC('Rémunération'),
      ligneBrut, ligneNbi, ligneResidence, ligneResidenceNbi('TauxResidenceNbiAutre'), ligneSft,
      lignesImt('ImtMontantDetache'), ligneIcCsg,
      L('Intéressement', { pay: I('Interessement') }),
      L('IFSE', { pay: I('Ifse') }),
      L('ISP', { pay: I('Isp') }),
      L('Prime 31', { pay: I('Prime31') }),
      L('CIA', { pay: I('Cia') }),
      L('Indemnité dégressive', { pay: I('Degressive') }),
      lignePsc, ligneCarteOrange, ligneAvantageNature(true), ligneIndDefisc, ligneIhts, ligneInterventions,
      SEC('Retenues'),
      ...pcDeductions,
      ...csgLines(),
      ligneReduc,
      L('RAFP', {
        base: K('RafpBase'), taux: Fn((r, b) => (r.Parlementaire ? 0 : b.Rafp), 'pct'), ded: K('RafpSal'),
      }),
      ligneRegul, ligneMutuelle, lignePrefon,
      SEC('Totaux'),
      ...netRows,
      ...fonctionnairePat({ retraite: pcPat('M2'), rafpNul: (r) => !!r.Parlementaire }),
    ],
    summary: summaryPension,
    defaults: { Statut: 'A2' },
  };

  // ==========================================================================
  //  4. CONTRACTUEL  (table "SimulationsContractuel")
  // ==========================================================================
  const cplaf = (r, b) => n(b.PlafondSS) * n(r.Quotite);
  const CON = {
    key: 'con',
    label: 'Agent contractuel',
    tableNames: ['SimulationsContractuel'],
    detect: (c) => c.has('IrcantecTBSeul') && c.has('HeuresSup1'),
    situation: [
      { cell: I('Nom', 'text'), label: 'Nom', wide: true },
      { cell: I('Quotite', 'num'), label: 'Quotité' },
      { cell: I('Contrat1an', 'bool', { caption: 'Contrat ≤ 1 an' }), label: 'Option' },
      { cell: I('IrcantecTBSeul', 'bool', { caption: 'Ircantec tranche B seule' }), label: 'Option' },
    ],
    lines: [
      SEC('Rémunération'),
      ligneBrut, ligneNbi, ligneResidence, ligneResidenceNbi('TauxResidenceNbiAutre'), ligneSft,
      L('ISP', { pay: I('Isp') }),
      L('Prime 22', { pay: I('Prime22') }),
      L('Prime 23', { pay: I('Prime23') }),
      L('Prime 24', { pay: I('Prime24') }),
      lignePsc,
      L('Indemnité compensatrice de CSG', { pay: I('IcCsgMontant') }),
      ligneCarteOrange, ligneIndDefisc,
      L('Heures supplémentaires', {
        hint: 'saisir le nombre d’heures',
        pay: K('HeuresSup'),
        sub: [
          I('HeuresSup1', 'num', { label: 'Tranche 1' }),
          I('HeuresSup2', 'num', { label: 'Tranche 2' }),
          I('HeuresSupDim', 'num', { label: 'Dimanche / férié' }),
        ],
      }),
      ligneInterventions,
      SEC('Éléments informatifs'),
      ligneAvantageNature(false),
      L('Assiette brute', { base: K('AssietteBrute'), info: true }),
      SEC('Retenues'),
      L('Sécurité sociale vieillesse plafonnée', {
        base: Fn((r, b) => (r.IrcantecTBSeul ? 0 : Math.min(cplaf(r, b), n(r.AssietteBrute) + n(r.Psc15)))),
        taux: Bt('SecuVieillessePlaf'), ded: K('VieillessePlafSal'),
      }),
      ...csgLines(),
      L('Maladie déplafonnée', {
        base: Fn((r) => n(r.AssietteBrute) + n(r.Psc15)), taux: Bt('MaladieDeplafSal'), ded: K('MaladieDeplafSal'),
      }),
      L('Vieillesse déplafonnée', { base: K('AssietteBrute'), taux: Bt('VieillesseDeplafSal'), ded: K('VieillesseDeplafSal') }),
      L('Ircantec tranche A', {
        base: Fn((r, b) => (r.IrcantecTBSeul ? 0 : Math.min(n(r.BaseIrcantec), cplaf(r, b)))),
        taux: Bt('IrcantecTaSal'), ded: K('IrcantecTaSal'),
      }),
      L('Ircantec tranche B', {
        base: Fn((r, b) => (r.IrcantecTBSeul ? n(r.BaseIrcantec) : Math.max(n(r.BaseIrcantec) - cplaf(r, b), 0))),
        taux: Bt('IrcantecTbSal'), ded: K('IrcantecTbSal'),
      }),
      ligneRegul, ligneMutuelle, lignePrefon,
      SEC('Totaux'),
      ...netRows,
      SEC('Part patronale'),
      L('Allocations familiales', { base: K('AssietteBrute'), taux: Bt('PatCafGeneral'), pat: K('PatCaf') }),
      L('Majoration allocations familiales', { base: K('AssietteBrute'), taux: Bt('PatAfMajoration'), pat: K('PatAfMajoration') }),
      L('Accident du travail', {
        base: Fn((r) => (r.Contrat1an ? n(r.AssietteBrute) + n(r.Psc15) : 0)),
        taux: Bt('PatAccidentTravail'), pat: K('PatAccidentTravail'),
      }),
      L('FNAL', { base: K('AssietteBrute'), taux: Bt('PatFnal'), pat: K('PatFnal') }),
      L('Vieillesse plafonnée', {
        base: Fn((r, b) => (n(r.AssietteBrute) - n(r.Residence) > cplaf(r, b) ? cplaf(r, b) : n(r.AssietteBrute))),
        taux: Bt('PatVieillessePlaf'), pat: K('PatVieillessePlaf'),
      }),
      L('Vieillesse déplafonnée', { base: K('AssietteBrute'), taux: Bt('PatVieillesseDeplaf'), pat: K('PatVieillesseDeplaf') }),
      L('Contribution solidarité autonomie (CSA)', { base: K('AssietteBrute'), taux: Bt('PatCsa'), pat: K('PatCsa') }),
      L('Maladie', { base: K('AssietteBrute'), taux: Bt('PatMaladieContractuel'), pat: K('PatMaladie') }),
      L('Majoration maladie', { base: K('AssietteBrute'), taux: Bt('PatMaladieMajoration'), pat: K('PatMaladieMajoration') }),
      L('Forfait social (PSC)', { base: K('Psc15'), taux: Bt('ForfaitSocial'), pat: K('PatForfaitSocial') }),
      L('Ircantec tranche A', {
        base: Fn((r, b) => (r.IrcantecTBSeul ? 0 : Math.min(n(r.BaseIrcantec), cplaf(r, b)))),
        taux: Bt('PatIrcantecTa'), pat: K('PatIrcantecTa'),
      }),
      L('Ircantec tranche B', {
        base: Fn((r, b) => (r.IrcantecTBSeul ? n(r.BaseIrcantec) : Math.max(n(r.BaseIrcantec) - cplaf(r, b), 0))),
        taux: Bt('PatIrcantecTb'), pat: K('PatIrcantecTb'),
      }),
      L('Versement mobilité (transport)', { base: K('AssietteBrute'), taux: Bt('PatTransport'), pat: K('PatTransport') }),
      ...patTail(),
    ],
    summary: [
      { label: 'Régime indemnitaire annuel', cell: K('RegimeIndemnitaireAnnuel') },
      { label: 'Total brut annuel', cell: K('TotalBrutAnnuel') },
      { label: 'Charges employeur annuelles', cell: K('ChargeEmployeurAnnuelle') },
      { label: 'dont Ircantec', cell: K('ChargeIrcantec') },
      { label: 'dont hors Ircantec', cell: K('ChargeHorsIrcantec') },
      { label: 'Coût complet année pleine', cell: K('CoutCompletAnneePleine'), strong: true },
      { label: 'Jours (proratisation)', cell: I('Jours', 'int', { unit: 'j' }) },
      { label: 'Coût proratisé', cell: K('CoutProratise'), strong: true },
    ],
    defaults: {},
  };

  // ==========================================================================
  //  5. COMPLÉMENTS  (table "Complements")
  // ==========================================================================
  const COM = {
    key: 'com',
    label: 'Complément de rémunération',
    tableNames: ['Complements'],
    detect: (c) => c.has('NetSouhaite'),
    situation: [
      { cell: I('Nom', 'text'), label: 'Nom', wide: true },
      { cell: I('Type', 'choice'), label: 'Type' },
      { cell: I('IrcantecTBSeul', 'bool', { caption: 'Ircantec tranche B seule' }), label: 'Option (ANT)' },
    ],
    lines: [
      SEC('Rémunération'),
      L('Montant brut saisi', { base: I('Montant') }),
      L('Net souhaité', {
        hint: 'type Titulaire uniquement : le brut est alors calculé pour obtenir ce net',
        base: I('NetSouhaite'),
      }),
      L('Montant brut retenu', { pay: K('MontantRetenu') }),
      SEC('Retenues'),
      L('CSG non déductible', {
        base: K('AssietteCsg'), taux: Fn((r, b) => (r.Type === 'IJSS' ? 0 : b.CsgNonDed), 'pct'), ded: K('CsgNonDed'),
      }),
      L('CSG déductible', {
        base: K('AssietteCsg'), taux: Fn((r, b) => (r.Type === 'IJSS' ? b.CsgIjss : b.CsgDed), 'pct'), ded: K('CsgDed'),
      }),
      L('CRDS', { base: K('AssietteCsg'), taux: Bt('Crds'), ded: K('Crds') }),
      L('Sécurité sociale vieillesse plafonnée', {
        base: Fn((r, b) => (r.Type === 'ANT' && !r.IrcantecTBSeul ? Math.min(n(b.PlafondSS), n(r.MontantRetenu)) : 0)),
        taux: Bt('SecuVieillessePlaf'), ded: K('VieillessePlaf'),
      }),
      L('Maladie déplafonnée', { base: Fn((r) => (r.Type === 'ANT' ? n(r.MontantRetenu) : 0)), taux: Bt('MaladieDeplafSal'), ded: K('MaladieDeplaf') }),
      L('Vieillesse déplafonnée', { base: Fn((r) => (r.Type === 'ANT' ? n(r.MontantRetenu) : 0)), taux: Bt('VieillesseDeplafSal'), ded: K('VieillesseDeplaf') }),
      L('Ircantec tranche A', {
        base: Fn((r, b) => (r.Type === 'ANT' && !r.IrcantecTBSeul ? Math.min(n(r.MontantRetenu), n(b.PlafondSS)) : 0)),
        taux: Bt('IrcantecTaSal'), ded: K('IrcantecTA'),
      }),
      L('Ircantec tranche B', {
        base: Fn((r, b) => (r.Type !== 'ANT' ? 0 : r.IrcantecTBSeul ? n(r.MontantRetenu) : Math.max(n(r.MontantRetenu) - n(b.PlafondSS), 0))),
        taux: Bt('IrcantecTbSal'), ded: K('IrcantecTB'),
      }),
      L('Contribution de solidarité', { base: K('MontantRetenu'), taux: Bt('ContribSolidarite'), ded: K('ContribSolidarite') }),
      SEC('Totaux'),
      TOT('TOTAL À PAYER', { pay: K('MontantRetenu') }),
      TOT('TOTAL À DÉDUIRE', { ded: K('TotalADeduire') }),
      TOT('NET AVANT PRÉLÈVEMENT À LA SOURCE', { pay: K('NetAvantPAS'), cls: 'net1' }),
      pasLine,
      TOT('NET À PAYER APRÈS PAS', { pay: K('NetApresPAS'), cls: 'net2' }),
    ],
    summary: [],
    defaults: { Type: 'Titulaire' },
  };

  // Ordre de détection : du plus spécifique au plus général
  window.PAIE_TYPES = [CON, COM, DET, FPT, TIT];

  // Valeurs de secours pour les listes de choix (la vraie liste est lue dans Grist si possible)
  window.PAIE_CHOICES = {
    tit: { Statut: ['1', 'A1', 'M1', 'P1'], CatTransfert: ['Cat A+', 'Cat A', 'Cat B', 'Cat C'] },
    fpt: { Statut: ['4', '5', '6'], CatTransfert: ['Cat A+', 'Cat A', 'Cat B', 'Cat C'] },
    det: { Statut: ['A2', 'M2', 'P2'] },
    con: {},
    com: { Type: ['Titulaire', 'ANT', 'IJSS'] },
  };

  // Valeurs par défaut d'une nouvelle ligne
  window.PAIE_NEW_DEFAULTS = { Quotite: 1, Jours: 360, Nom: 'Nouvelle simulation' };
})();
