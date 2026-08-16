# Mes Randos

Petite web app perso : une carte où tu traces tes randos (clic par clic, en suivant les sentiers),
tu leur donnes un nom, et la distance + le dénivelé sont calculés automatiquement.

Le site est déjà en ligne : https://hapla-ventre.github.io/mes-randos/

## Mise en place (à faire une seule fois, ~10 min)

### 1. Créer le projet Firebase (gratuit)

1. Va sur https://console.firebase.google.com et crée un projet (le nom n'a pas d'importance).
2. Dans le menu de gauche, va dans **Build > Authentication** > **Get started**, onglet **Sign-in method**,
   active le fournisseur **Email/Password**.
3. Va dans **Build > Firestore Database** > **Create database**, choisis le mode **production**, une région proche (ex. `eur3`).
4. Une fois la base créée, onglet **Rules**, remplace le contenu par celui du fichier [`firestore.rules`](firestore.rules)
   de ce dossier, puis **Publish**. Ça garantit que chacun ne voit que ses propres randos.
5. Dans **Project settings** (roue crantée en haut à gauche) > onglet **General**, descends jusqu'à **Your apps**,
   clique l'icône `</>` pour ajouter une "web app" (nom libre, pas besoin de cocher Hosting). Firebase t'affiche
   un objet `firebaseConfig` : garde cette page ouverte pour l'étape suivante.
6. Toujours dans **Authentication > Settings > Authorized domains**, clique **Add domain** et ajoute :
   `hapla-ventre.github.io` (sinon la connexion sera refusée depuis le site en ligne).

### 2. Configurer l'app avec tes clés

1. Ouvre [`config.example.js`](config.example.js), copie son contenu.
2. Sur https://github.com/Hapla-ventre/mes-randos, clique **Add file > Create new file**, nomme-le `config.js`,
   colle le contenu, puis remplace chaque valeur par celles de ton `firebaseConfig` (étape 5 ci-dessus).
3. Commit directement sur `main`. Le site se met à jour tout seul en ~1 minute.

(`config.js` n'est pas dans le dépôt de base exprès — sur ton PC, `config.js` reste ignoré par git,
donc si tu modifies le code en local pense à le recréer toi-même avec tes clés pour tester.)

### 3. Créer ton compte dans l'app

Ouvre https://hapla-ventre.github.io/mes-randos/, clique **Créer un compte** avec ton email et un mot de passe.
C'est un compte séparé de tout le reste (juste pour protéger tes données dans Firebase) — connecte-toi ensuite normalement.

### 4. (Optionnel mais conseillé) Faire suivre les sentiers au tracé

Sans cette étape, l'app trace une ligne droite entre tes points. Avec une clé gratuite OpenRouteService,
elle calcule un vrai itinéraire à pied le long des chemins, avec dénivelé et type de terrain.

1. Va sur https://openrouteservice.org, clique **Sign up**, crée un compte gratuit.
2. Une fois connecté, va dans **Dashboard > Request a token**, choisis un nom libre, type **Standard**, valide.
3. Copie le token affiché.
4. Sur https://github.com/Hapla-ventre/mes-randos, ouvre `config.js` (bouton crayon pour éditer),
   remplace la ligne `ORS_API_KEY: ""` par `ORS_API_KEY: "ton-token-ici",`, puis **Commit changes**.

## Mettre à jour le code plus tard

Si tu modifies les fichiers en local, pousse simplement sur GitHub :

```bash
git add -A
git commit -m "description du changement"
git push
```

Le site se met à jour automatiquement en ~1 minute (GitHub Pages).

## Utilisation

- **+ Nouvelle rando** → clique sur la carte pour poser des points A, B, C… L'itinéraire entre eux suit
  automatiquement les sentiers (si la clé OpenRouteService est configurée).
- **Glisse un point** pour le corriger — le tracé se recalcule tout seul autour de sa nouvelle position,
  et peut ainsi "sauter" sur un autre chemin.
- **↩ Annuler point** retire le dernier point posé. **Terminer le tracé** fige distance, dénivelé, pente
  max et type de terrain.
- Donne un nom, une date, des notes éventuelles, puis **Enregistrer**.
- La carte affiche toutes tes randos en gris discret, comme une toile de tes parcours. Clique sur une rando
  (liste ou carte) pour la faire ressortir en couleur, voir ses stats, son profil d'altitude, et la supprimer.

## Notes techniques

- Le dénivelé et le type de terrain viennent d'OpenRouteService quand le tracé est routé ; sans clé, ou si
  l'itinéraire est indisponible, l'app trace une ligne directe et calcule l'altitude via Open-Meteo (~90m de résolution).
- Fond de carte IGN disponible via le sélecteur de calques en haut à droite (plus lisible pour la rando en France).
- Aucune donnée n'est envoyée ailleurs qu'à ton propre projet Firebase, à OpenRouteService (pour le calcul d'itinéraire)
  et à Open-Meteo (altitude, en secours, anonyme et sans clé).
- Leaflet et le SDK Firebase sont embarqués localement dans `vendor/` (pas de dépendance à un CDN externe).
- L'édition ne concerne que le tracé en cours : une rando déjà enregistrée ne peut pas être re-modifiée pour
  l'instant (seulement consultée ou supprimée) — à ajouter plus tard si besoin.
