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

(`config.js` est bien versionné sur GitHub — c'est ce qui permet à GitHub Pages de le servir. Ce n'est pas un souci
de sécurité : ces valeurs Firebase ne sont pas des secrets, voir la note à ce sujet plus bas.)

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
  automatiquement les sentiers (si la clé OpenRouteService est configurée). Chaque point posé apparaît
  aussi dans une liste sous la carte, avec un ✕ pour le supprimer individuellement.
- **Glisse un point** (sur la carte ou via la poignée A/B/C…) pour le corriger — le tracé se recalcule
  tout seul autour de sa nouvelle position. Tu peux aussi **cliquer-glisser directement sur le tracé**
  entre deux points pour y insérer un nouveau point et le faire "sauter" sur un autre chemin.
- **↩ Annuler point** retire le dernier point posé. **Terminer le tracé** fige distance, dénivelé, pente
  max et type de terrain.
- Donne un nom, une date, des notes éventuelles, puis **Enregistrer**.
- Sur la carte, une rando enregistrée est **rouge avec des flèches noires à contour blanc** indiquant le
  sens de parcours. En la sélectionnant (liste ou clic sur la carte) elle passe en **rayures rouge/blanc**
  pour bien ressortir, et tu peux voir ses stats, son profil d'altitude, la modifier ou la supprimer.
- Dans le panneau d'une rando, coche **Masquer les autres randos** pour ne garder que celle-ci affichée
  (la vue se recentre dessus) — pratique pour l'examiner sans le reste de la carte autour.
- Dans le panneau d'une rando, le **nom et la date sont modifiables directement** — change-les puis clique
  **💾 Enregistrer nom / date / notes** (ça ne touche pas au tracé, donc ni recalcul ni doublon).
- **✎ Modifier le tracé** repasse en mode édition des points : la rando devient **bleue**, ses points
  redeviennent déplaçables/ajoutables comme à la création, et toutes les autres randos disparaissent le
  temps de l'édition pour ne pas gêner. Enregistrer met à jour la même rando.
- **Couleurs distinctes par rando** (case à cocher) : donne une couleur propre à chaque rando au lieu du
  rouge uniforme. Les tronçons partagés par plusieurs randos s'écartent légèrement pour rester lisibles,
  un peu comme des lignes de métro qui se longent sans se superposer.
- Le sélecteur de calques (haut à droite) propose un fond **Relief** avec courbes de niveau et estompage,
  en plus d'OpenStreetMap et IGN.

## Notes techniques

- Le type de terrain vient d'OpenRouteService quand le tracé est routé ; sans clé, ou si l'itinéraire est
  indisponible, l'app trace une ligne directe et calcule l'altitude via Open-Meteo (~90m de résolution).
- Le dénivelé (D+/D-) est calculé par l'app elle-même avec un filtre à seuil (10m) sur l'altitude lissée,
  pas en sommant brut chaque micro-variation — sinon le bruit des données d'altitude gonfle vite les
  chiffres de plusieurs centaines de mètres sur une longue rando. Cette méthode est plus proche de celle
  des applis de rando sérieuses (Strava, Outdooractive…), mais le seuil exact diffère d'un outil à l'autre,
  donc un léger écart entre deux applis reste normal.
- Le fond **Relief** utilise les tuiles pré-calculées d'OpenTopoMap (courbes de niveau + ombrage à partir de
  données SRTM) — comme la plupart des applis de rando, l'estompage n'est pas recalculé à la volée dans le
  navigateur, ce serait beaucoup trop coûteux pour un rendu à la demande.
- Fond de carte IGN disponible via le même sélecteur (plus lisible pour la rando en France).
- L'écartement "métro" des randos superposées est une approximation par proximité de points (pas une vraie
  détection de tronçons partagés comme le ferait un logiciel de plan de transport) — largement suffisant
  pour distinguer tes randos, mais pas géométriquement parfait sur des croisements complexes.
- Aucune donnée n'est envoyée ailleurs qu'à ton propre projet Firebase, à OpenRouteService (pour le calcul d'itinéraire)
  et à Open-Meteo (altitude, en secours, anonyme et sans clé).
- Leaflet et le SDK Firebase sont embarqués localement dans `vendor/` (pas de dépendance à un CDN externe).
- `config.js` est public sur GitHub — c'est normal pour une app Firebase web (ces clés identifient le projet,
  elles ne donnent pas d'accès). Ce qui protège vraiment tes données, ce sont les règles Firestore
  ([`firestore.rules`](firestore.rules)) et la restriction de la clé API à `hapla-ventre.github.io` faite dans
  Google Cloud Console.
- Les flèches de direction et le style rayé viennent du plugin Leaflet.PolylineDecorator, également
  embarqué dans `vendor/`.
