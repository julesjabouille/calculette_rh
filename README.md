# Calculette RH – Fiche de paie (widget Grist)

Widget personnalisé Grist, hébergeable sur GitHub Pages (`https://<compte>.github.io/<depot>/`), qui affiche
une ligne d'une table de simulation sous la forme d'une **fiche de paie**.

- **Champs jaunes** = colonnes saisies (de `Nom` à `TauxPAS`, + `Jours`) : modifiables dans la fiche, écrits dans la table Grist.
- **Champs gris** = colonnes formules de Grist (brut, cotisations, net, PAS…) : recalculées par Grist et rafraîchies dans la fiche.
- Les modifications faites dans la table Grist apparaissent aussitôt dans la fiche (et inversement).

Tables gérées (détection automatique selon les colonnes) :
`Simulations` (titulaire FPE), `SimulationsFPT`, `SimulationsDetache`, `SimulationsContractuel`, `Complements`.

## Publier sur GitHub Pages

```bash
cd "calculette RH"
git init && git add . && git commit -m "Fiche de paie Grist"
git branch -M main
git remote add origin git@github.com:<compte>/<depot>.git
git push -u origin main
# GitHub > Settings > Pages > Source : "Deploy from a branch" > main / (root)
```

## Brancher dans Grist

1. Sur la page de la table (ex. `Simulations`), **Ajouter un widget** → *Personnalisé* (« Custom »).
2. URL : `https://<compte>.github.io/<depot>/`
3. Niveau d'accès : **Accès complet au document** (nécessaire pour lire `Baremes` et ses taux).
4. Source de données : la table concernée. Pas de mappage de colonnes à faire.
5. Pour naviguer : lier le widget à la vue tableau (*Sélectionner par*) ou utiliser le sélecteur en haut de la fiche.
   Les boutons *Nouvelle*, *Dupliquer*, *Supprimer* agissent sur la table.

Un widget par table : ajoutez-en un sur chaque page (`SimulationsFPT`, `SimulationsDetache`, …).

## Aperçu hors Grist

Ouvrir `index.html` via un serveur local (`python3 -m http.server`) affiche un **mode démo** avec les données de
`demo-data.js` (`?type=tit|fpt|det|con|com`). Les valeurs automatiques n'y sont pas recalculées.

## Fichiers

- `config.js` : description des lignes de la fiche pour chaque table (à adapter si les colonnes changent).
- `app.js` : rendu, lecture/écriture Grist.
- `style.css`, `index.html`, `mock-grist.js`, `demo-data.js`.
